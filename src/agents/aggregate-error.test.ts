import { describe, expect, it } from "vitest";
import { createPrimaryAndSecondaryAggregateError } from "./aggregate-error.js";

describe("createPrimaryAndSecondaryAggregateError", () => {
  it("preserves the primary failure and wraps the secondary failure with its own cause", () => {
    const primary = new Error("primary");
    const secondary = new Error("secondary");

    const aggregate = createPrimaryAndSecondaryAggregateError({
      primary,
      secondary,
      secondaryMessage: "secondary operation failed",
      aggregateMessage: "both operations failed",
    });

    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.message).toBe("both operations failed");
    expect(aggregate.cause).toBe(primary);
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBe(primary);
    expect(aggregate.errors[1]).toMatchObject({
      message: "secondary operation failed",
      cause: secondary,
    });
  });
});
