export interface CircuitRunInfo {
  isHead: boolean;
  isTail: boolean;
  rowSpan: number;
}

export interface CircuitRunItem {
  id: string;
  circuitGroupId: string;
}

function circuitRunGroupKey(circuit: CircuitRunItem): string {
  return circuit.circuitGroupId.trim() || circuit.id;
}

export function buildCircuitRunInfo(circuits: readonly CircuitRunItem[]): Map<string, CircuitRunInfo> {
  const map = new Map<string, CircuitRunInfo>();
  let index = 0;
  while (index < circuits.length) {
    const groupId = circuitRunGroupKey(circuits[index]);
    let end = index + 1;
    while (end < circuits.length && circuitRunGroupKey(circuits[end]) === groupId) {
      end += 1;
    }
    const rowSpan = end - index;
    for (let current = index; current < end; current += 1) {
      map.set(circuits[current].id, {
        isHead: current === index,
        isTail: current === end - 1,
        rowSpan,
      });
    }
    index = end;
  }
  return map;
}
