export function createPrimaryAndSecondaryAggregateError(params: {
  primary: unknown;
  secondary: unknown;
  secondaryMessage: string;
  aggregateMessage: string;
}): AggregateError {
  const secondaryError = new Error(params.secondaryMessage, {
    cause: params.secondary,
  });
  return new AggregateError([params.primary, secondaryError], params.aggregateMessage, {
    cause: params.primary,
  });
}
