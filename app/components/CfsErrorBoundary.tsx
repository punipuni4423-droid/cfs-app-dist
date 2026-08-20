"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import ActionIconButton from "./ActionIconButton";

interface CfsErrorBoundaryProps {
  children: ReactNode;
  projectName: string;
  roomTypeName: string;
  resetKey: string;
}

interface CfsErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  errorId: string;
}

function makeErrorId(): string {
  return `CFS-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function firstUsefulLine(value: string, matcher: RegExp): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => matcher.test(line)) ?? "";
}

function stackPreview(value: string, maxLines = 12): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}

function inferCfsLocation(error: Error, errorInfo: ErrorInfo | null): string {
  const componentStack = errorInfo?.componentStack ?? "";
  const runtimeStack = error.stack ?? "";
  const componentLine = firstUsefulLine(componentStack, /Cfs|LinkMap|Matrix|Inspection|Scene|Switch/i);
  const fileLine = firstUsefulLine(runtimeStack, /Cfs|cfs|useCfs|cfsTable|cfsValue|cfsLink/i);
  return componentLine || fileLine || "CFS tab render path";
}

function diagnosticText(
  props: CfsErrorBoundaryProps,
  state: CfsErrorBoundaryState,
): string {
  const error = state.error;
  const componentStack = state.errorInfo?.componentStack ?? "";
  return [
    `Error ID: ${state.errorId}`,
    `Project: ${props.projectName}`,
    `Room Type: ${props.roomTypeName}`,
    `Error: ${error?.name ?? "Error"}: ${error?.message ?? ""}`,
    `Estimated location: ${error ? inferCfsLocation(error, state.errorInfo) : "CFS tab"}`,
    "",
    "Runtime stack:",
    stackPreview(error?.stack ?? "-"),
    "",
    "Component stack:",
    stackPreview(componentStack || "-"),
  ].join("\n");
}

export default class CfsErrorBoundary extends Component<CfsErrorBoundaryProps, CfsErrorBoundaryState> {
  state: CfsErrorBoundaryState = {
    error: null,
    errorInfo: null,
    errorId: makeErrorId(),
  };

  static getDerivedStateFromError(error: Error): Partial<CfsErrorBoundaryState> {
    return {
      error,
      errorId: makeErrorId(),
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error("CFS tab render error", {
      errorId: this.state.errorId,
      projectName: this.props.projectName,
      roomTypeName: this.props.roomTypeName,
      error,
      errorInfo,
    });
  }

  componentDidUpdate(prevProps: CfsErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({
        error: null,
        errorInfo: null,
        errorId: makeErrorId(),
      });
    }
  }

  reset = (): void => {
    this.setState({
      error: null,
      errorInfo: null,
      errorId: makeErrorId(),
    });
  };

  copyDiagnostic = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(diagnosticText(this.props, this.state));
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const error = this.state.error;
    const estimatedLocation = inferCfsLocation(error, this.state.errorInfo);
    const details = diagnosticText(this.props, this.state);

    return (
      <section className="card card-padded cfs-error-card" role="alert" aria-live="assertive">
        <div className="cfs-error-kicker">CFS Error</div>
        <div className="cfs-error-head">
          <div>
            <h2>CFSタブでエラーが発生しました</h2>
            <p>
              CFSだけで検知しています。他のタブはそのまま確認できます。
              下の情報を見れば、どのCFS経路で落ちたかを追いやすくなります。
            </p>
          </div>
          <span className="cfs-error-id">{this.state.errorId}</span>
        </div>

        <dl className="cfs-error-grid">
          <div>
            <dt>Project</dt>
            <dd>{this.props.projectName || "-"}</dd>
          </div>
          <div>
            <dt>Room Type</dt>
            <dd>{this.props.roomTypeName || "-"}</dd>
          </div>
          <div>
            <dt>Error</dt>
            <dd>{error.name}: {error.message}</dd>
          </div>
          <div>
            <dt>Estimated Location</dt>
            <dd><code>{estimatedLocation}</code></dd>
          </div>
        </dl>

        <details className="cfs-error-details">
          <summary>Codex確認用の詳細を表示</summary>
          <pre>{details}</pre>
        </details>

        <div className="cfs-error-actions">
          <button type="button" className="btn btn-primary" onClick={this.reset}>
            Retry CFS
          </button>
          <ActionIconButton
            icon="copy"
            label="Copy Diagnostic"
            className="btn-secondary"
            onClick={this.copyDiagnostic}
          />
        </div>
      </section>
    );
  }
}
