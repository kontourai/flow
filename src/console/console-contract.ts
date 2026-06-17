/**
 * Stable contract subpath — `@kontourai/flow/console-contract`.
 *
 * Flow OWNS the console projection payload. This module is the typed contract
 * surface other planes import (mirroring how Surface ships
 * `@kontourai/surface/trust-panel/element`): the `FlowConsoleProjection` shape
 * and its parts, plus the `ConsoleSink` seam. Console depends on THIS so its
 * flow-bridge/ingest consumes Flow's exported types instead of redefining them.
 *
 * It deliberately re-exports only the contract (types + sink + the pure
 * `projectFlowRun` projector), NOT the loopback HTTP server, so consumers take a
 * dependency on the payload contract without pulling Flow's server runtime.
 */
export type {
  FlowConsoleProjection,
  FlowConsoleRunIdentity,
  FlowConsoleDefinitionProjection,
  FlowConsoleStepProjection,
  FlowConsoleExpectationProjection,
  FlowConsoleEvidenceProjection,
  FlowConsoleGateProjection,
  FlowConsoleExceptionProjection,
  FlowConsoleTransitionProjection,
  FlowConsoleRouteBackProjection,
  FlowConsoleReportProjection,
  FlowConsoleExternalLinkRef,
  FlowConsoleExternalLinkKind,
  FlowConsoleProjectionOptions,
  FlowConsoleRunParts
} from "./console-projection.js";

export { projectFlowRun } from "./console-projection.js";

export type {
  ConsoleSink,
  ConsoleSinkConfig,
  FileConsoleSinkOptions,
  HostedConsoleSinkOptions,
  FlowIngestRequest
} from "./console-sink.js";

export {
  FileConsoleSink,
  HostedConsoleSink,
  createConsoleSink
} from "./console-sink.js";
