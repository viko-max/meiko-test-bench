/**
 * Typed errors for Meiko Test-Bench. These encode the hard invariants from
 * AGENTS.md so violations fail loudly instead of silently degrading.
 */

export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A credential value (not just an env-var name) appeared in config/data/code. */
export class CredentialInConfigError extends HarnessError {
  constructor(where: string, hits: string[]) {
    super(
      "CREDENTIAL_IN_CONFIG",
      `Credential-shaped value found in ${where}: ${hits.join(", ")}. ` +
        `Only environment variable NAMES may be recorded (AGENTS.md §4).`,
    );
  }
}

/** Scoring material (answer/rubric/etc.) reached a public request or tool input. */
export class AnswerIsolationError extends HarnessError {
  constructor(detail: string) {
    super("ANSWER_ISOLATION", `Answer-isolation violation: ${detail} (AGENTS.md §5).`);
  }
}

/** Contract/validation failure for datasets, configs, or run specs. */
export class ContractError extends HarnessError {
  constructor(message: string) {
    super("CONTRACT", message);
  }
}

/** A tool or run boundary was exceeded (time, output size, tool-call budget). */
export class LimitExceededError extends HarnessError {
  readonly limit: string;
  constructor(limit: string, detail: string) {
    super("LIMIT_EXCEEDED", `Protection limit '${limit}' exceeded: ${detail} (AGENTS.md §7/§9).`);
    this.limit = limit;
  }
}

/** A file reference escaped the current trial's allowed roots. */
export class PathEscapeError extends HarnessError {
  constructor(detail: string) {
    super("PATH_ESCAPE", `File reference outside allowed roots: ${detail} (AGENTS.md §9).`);
  }
}
