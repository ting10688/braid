export class BraidError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidInputError extends BraidError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 2, options);
  }
}

export class AnalysisError extends BraidError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 3, options);
  }
}

export class PersistenceError extends BraidError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 1, options);
  }
}
