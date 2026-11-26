export class PriceAdministrationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PriceAdministrationError";
    this.status = status;
    this.code = code;
  }
}
