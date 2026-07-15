export class BraidError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MigrationSafetyError extends BraidError {
  constructor(
    message: string,
    exitCode: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, exitCode, options);
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
