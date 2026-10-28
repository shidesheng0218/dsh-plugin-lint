export class ToolError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ToolError';
    this.code = code;
  }
}
