export type LinkKind = "surface" | "veritas" | "artifact" | "pull-request" | "ci" | "release-report";

export interface ConsoleLink {
  id: string;
  kind: LinkKind;
  label?: string;
  href?: string;
  path?: string;
  source: string;
  target_id?: string;
}

export interface ConsoleStep {
  id: string;
  index: number;
  label: string;
  next: string | null;
  gates: string[];
}

export interface ConsoleExpectation {
  id: string;
  kind: string | null;
  required: boolean;
  description: string | null;
}

export interface ConsoleEvidence {
  id: string;
  gate_id: string | null;
  kind: string | null;
  status: string | null;
  producer: string | null;
  stored_path: string | null;
  route_reason: string | null;
  diagnostics: Record<string, unknown> | null;
  external_links: ConsoleLink[];
}

export interface ConsoleGate {
  id: string;
  step_id: string;
  status: string;
  summary: string;
  is_open: boolean;
  expectations: ConsoleExpectation[];
  evidence: ConsoleEvidence[];
  missing: string[];
  optional_missing: string[];
  accepted_exception_id?: string;
  route_back_to?: string;
  selected_route?: string;
  recovery_step?: string;
  route_reason?: string;
  attempt?: number;
  max_attempts?: number;
}

export interface ConsoleTransition {
  id: string;
  type: string;
  from_step: string | null;
  to_step: string | null;
  status: string | null;
  gate_id: string | null;
  reason: string | null;
  route_reason: string | null;
  at: string | null;
}

export interface ConsoleProjection {
  run: {
    run_id: string;
    subject: string | null;
    status: string | null;
    current_step: string | null;
    updated_at: string | null;
  };
  definition: {
    title: string | null;
    description: string | null;
  };
  steps: ConsoleStep[];
  current_step: string | null;
  open_gates: string[];
  gates: ConsoleGate[];
  transitions: ConsoleTransition[];
  external_links: ConsoleLink[];
  next_action: string | null;
  continuation: string;
}
