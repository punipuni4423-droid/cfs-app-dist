# Protocol-v1 payload helper. No process enumeration or PID-based termination.
if (-not ('CfsUpdate.NativeJob' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace CfsUpdate {
 public sealed class OutputChunk { public string Stream; public string Text; public string Utc; public long Bytes; }
 public sealed class JobSample {
  public Exception PipeFailure;
  public bool RootExited, Empty, PipesClosed, PipeReadFailed; public int ExitCode; public uint Active;
  public double CpuMs; public ulong ReadBytes, WriteBytes; public long OutputBytes, DroppedBytes;
 }
 public sealed class NativeJob : IDisposable {
  const uint STILL_ACTIVE=259, WAIT_OBJECT_0=0;
  IntPtr job, process; Stream stdout, stderr; Thread outThread, errThread;
  readonly Queue<OutputChunk> queue=new Queue<OutputChunk>(); readonly object gate=new object();
  long queuedBytes, outputBytes, droppedBytes; volatile bool outDone, errDone, pipeReadFailed; Exception pipeFailure;
  public int Pid {get;private set;} public bool Disposed {get;private set;}
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Size; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {
   public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
   public short show,reserved2; public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SIX {public SI startup; public IntPtr attributes;}
  [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread; public int pid,tid;}
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public IntPtr affinity; public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct IO {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct Limits {public BasicLimit basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
  [StructLayout(LayoutKind.Sequential)] struct Accounting {public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; public IO io;}
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Limits l,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,out Accounting a,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr r,out IntPtr w,ref SA a,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr a,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr prev,IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool result);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr p,uint time);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryUnbiasedInterruptTime(out ulong time);
  public static double AwakeMs() {ulong time; Check(QueryUnbiasedInterruptTime(out time),"awake_clock"); return time/10000.0;}
  static void Check(bool ok,string name) {if(!ok){int code=Marshal.GetLastWin32Error();var error=new InvalidOperationException(name+":"+code);error.Data["CfsNativeStage"]=name;error.Data["CfsWin32Code"]=code;throw error;}}
  static void Close(ref IntPtr h) {if(h!=IntPtr.Zero){CloseHandle(h);h=IntPtr.Zero;}}
  public NativeJob(string executable,string arguments,string cwd) {
   IntPtr ro=IntPtr.Zero,wo=IntPtr.Zero,re=IntPtr.Zero,we=IntPtr.Zero,ri=IntPtr.Zero,wi=IntPtr.Zero;
   IntPtr attrs=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero; bool attributesReady=false;
   try {
    job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create_job");
    Limits limits=new Limits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
    Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))),"limit_job");
    SA sa=new SA{Size=Marshal.SizeOf(typeof(SA)),Inherit=1};
    Check(CreatePipe(out ro,out wo,ref sa,0),"stdout_pipe"); Check(SetHandleInformation(ro,1,0),"stdout_private");
    Check(CreatePipe(out re,out we,ref sa,0),"stderr_pipe"); Check(SetHandleInformation(re,1,0),"stderr_private");
    Check(CreatePipe(out ri,out wi,ref sa,0),"stdin_pipe"); Check(SetHandleInformation(wi,1,0),"stdin_private");
    IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
    attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"initialize_attributes");attributesReady=true;
    jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
    Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"job_list");
    handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,ri);Marshal.WriteIntPtr(handles,IntPtr.Size,wo);Marshal.WriteIntPtr(handles,IntPtr.Size*2,we);
    Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"handle_list");
    SIX si=new SIX();si.startup.cb=Marshal.SizeOf(typeof(SIX));si.startup.flags=0x100;si.startup.input=ri;si.startup.output=wo;si.startup.error=we;si.attributes=attrs;
    PI pi; Check(CreateProcess(executable,new StringBuilder("\""+executable+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,cwd,ref si,out pi),"create_owned_process");
    process=pi.process;Pid=pi.pid;CloseHandle(pi.thread);
    bool inJob;Check(IsProcessInJob(process,job,out inJob)&&inJob,"verify_job");
    Close(ref wo);Close(ref we);Close(ref ri);Close(ref wi);
    stdout=new FileStream(new SafeFileHandle(ro,true),FileAccess.Read,4096,false);ro=IntPtr.Zero;
    stderr=new FileStream(new SafeFileHandle(re,true),FileAccess.Read,4096,false);re=IntPtr.Zero;
    outThread=new Thread(()=>Pump(stdout,"stdout"));errThread=new Thread(()=>Pump(stderr,"stderr"));outThread.IsBackground=true;errThread.IsBackground=true;outThread.Start();errThread.Start();
   } catch(Exception failure) {
    bool retain=false;
    if(process!=IntPtr.Zero){
     bool verified=false;
     try{Check(TerminateJobObject(job,1460),"constructor_cleanup");for(int i=0;i<50;i++){Accounting a;if(QueryInformationJobObject(job,8,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)&&a.active==0&&WaitForSingleObject(process,0)==0){verified=true;break;}Thread.Sleep(100);}}catch{}
     failure.Data["CfsCleanupUncertain"]=!verified;
     if(!verified){failure.Data["CfsOwnedJob"]=this;retain=true;}
    }
    if(!retain)Dispose();throw;
   } finally {
    Close(ref ro);Close(ref wo);Close(ref re);Close(ref we);Close(ref ri);Close(ref wi);
    if(attributesReady)DeleteProcThreadAttributeList(attrs);if(attrs!=IntPtr.Zero)Marshal.FreeHGlobal(attrs);if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
   }
  }
  void Pump(Stream source,string name) {
   byte[] bytes=new byte[4096];char[] chars=new char[4098];Decoder decoder=new UTF8Encoding(false,false).GetDecoder();
   try {int n;while((n=source.Read(bytes,0,bytes.Length))>0) {
    int count=decoder.GetChars(bytes,0,n,chars,0,false);
    lock(gate){outputBytes+=n;if(queuedBytes+n<=1048576){queue.Enqueue(new OutputChunk{Stream=name,Text=new string(chars,0,count),Utc=DateTime.UtcNow.ToString("o"),Bytes=n});queuedBytes+=n;}else droppedBytes+=n;}
   }
    int tail=decoder.GetChars(new byte[0],0,0,chars,0,true);
    if(tail>0){lock(gate){queue.Enqueue(new OutputChunk{Stream=name,Text=new string(chars,0,tail),Utc=DateTime.UtcNow.ToString("o"),Bytes=0});}}
   } catch(Exception error) {lock(gate){error.Data["CfsNativeStage"]=name=="stdout"?"stdout_read":"stderr_read";if(pipeFailure==null)pipeFailure=error;pipeReadFailed=true;}} finally {source.Dispose();if(name=="stdout")outDone=true;else errDone=true;}
  }
  public OutputChunk[] Drain() {lock(gate){var result=new List<OutputChunk>();long size=0;while(queue.Count>0&&size<65536){var c=queue.Dequeue();queuedBytes-=c.Bytes;size+=c.Bytes;result.Add(c);}return result.ToArray();}}
  public JobSample Sample() {
   Accounting a;Check(QueryInformationJobObject(job,8,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"job_accounting");
   uint code;Check(GetExitCodeProcess(process,out code),"process_exit");
   bool exited=WaitForSingleObject(process,0)==WAIT_OBJECT_0;
   lock(gate){return new JobSample{PipeFailure=pipeFailure,RootExited=exited,ExitCode=unchecked((int)code),Empty=a.active==0,PipesClosed=outDone&&errDone,PipeReadFailed=pipeReadFailed,Active=a.active,CpuMs=(a.user+a.kernel)/10000.0,ReadBytes=a.io.readBytes,WriteBytes=a.io.writeBytes,OutputBytes=outputBytes,DroppedBytes=droppedBytes};}
  }
  public void Terminate() {Check(TerminateJobObject(job,1460),"terminate_owned_job");}
  public void Dispose() {
   if(Disposed)return;Disposed=true;Close(ref job);Close(ref process);
   // Closing the owned job closes writers. Readers dispose themselves at EOF.
   if(outThread!=null){if(!outThread.Join(1000)&&stdout!=null)stdout.Dispose();}else if(stdout!=null)stdout.Dispose();
   if(errThread!=null){if(!errThread.Join(1000)&&stderr!=null)stderr.Dispose();}else if(stderr!=null)stderr.Dispose();
  }
 }
}
'@
}

function ConvertTo-CfsNativeArgument {
  param([string]$Value)
  return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}

function New-CfsOwnedCommand {
  param([string]$FilePath,[string[]]$Arguments,[string]$WorkingDirectory)
  $resolved = (Get-Command $FilePath -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  if ([IO.Path]::GetExtension($resolved) -in @('.cmd','.bat')) {
    # The updater supplies fixed arguments. Reject shell expansion in custom paths/args.
    foreach ($value in @($resolved) + $Arguments) { if ($value -match '["%!\r\n]') { throw 'unsafe_cmd_argument' } }
    $quotedArgs = @($Arguments | ForEach-Object { if ($_ -match '[\s&|<>^()]' -or $_ -eq '') { '"' + $_ + '"' } else { $_ } })
    $command = '""' + $resolved + '"' + $(if($quotedArgs.Count){' '+($quotedArgs -join ' ')}else{''}) + '"'
    return New-Object CfsUpdate.NativeJob((Join-Path $env:SystemRoot 'System32/cmd.exe'),('/d /s /c ' + $command),$WorkingDirectory)
  }
  $line = ($Arguments | ForEach-Object { ConvertTo-CfsNativeArgument $_ }) -join ' '
  return New-Object CfsUpdate.NativeJob($resolved,$line,$WorkingDirectory)
}
