import type { JsonValue } from "../core/json.js";
import type { Logger } from "../core/logger.js";

export interface ApprovalControllerOptions {
  logger: Logger;
  allowCommandApprovals?: boolean;
  allowFileApprovals?: boolean;
}

export class ApprovalController {
  readonly #logger: Logger;
  readonly #allowCommands: boolean;
  readonly #allowFiles: boolean;

  public constructor(options: ApprovalControllerOptions) {
    this.#logger = options.logger;
    this.#allowCommands = options.allowCommandApprovals ?? false;
    this.#allowFiles = options.allowFileApprovals ?? false;
  }

  public async handle(method: string, _params: JsonValue | undefined): Promise<JsonValue> {
    switch (method) {
      case "item/commandExecution/requestApproval":
        this.#logger.warn("Codex requested command approval", { decision: this.#allowCommands ? "accept" : "decline" });
        return { decision: this.#allowCommands ? "accept" : "decline" };
      case "item/fileChange/requestApproval":
        this.#logger.warn("Codex requested file-change approval", { decision: this.#allowFiles ? "accept" : "decline" });
        return { decision: this.#allowFiles ? "accept" : "decline" };
      case "item/permissions/requestApproval":
        this.#logger.warn("Codex requested extra permissions", { decision: "decline" });
        return { permissions: {}, scope: "turn", strictAutoReview: true };
      case "item/tool/requestUserInput":
      case "tool/requestUserInput":
        this.#logger.warn("Codex requested user input during unattended execution", { decision: "empty_answers" });
        return { answers: {} };
      case "mcpServer/elicitation/request":
        this.#logger.warn("An MCP server requested elicitation during unattended execution", { decision: "decline" });
        return { action: "decline", content: null };
      case "item/tool/call":
        this.#logger.warn("A dynamic tool call was requested but no dynamic tools are registered", { decision: "fail" });
        return { contentItems: [], success: false };
      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }
}
