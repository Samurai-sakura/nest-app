import { QueryFailedError } from "typeorm";
import { isDatabaseUnavailable } from "./database-unavailable";

const withCode = (code: string, message = "error") => Object.assign(new Error(message), { code });

const queryFailed = (code: string) =>
  new QueryFailedError("SELECT 1", [], withCode(code));

describe("isDatabaseUnavailable", () => {
  it.each([
    ["a refused connection", withCode("ECONNREFUSED")],
    ["a reset connection", withCode("ECONNRESET")],
    ["a connection failure of the query", queryFailed("08006")],
    ["a server shutdown", queryFailed("57P01")],
    ["too many connections", queryFailed("53300")],
    ["a terminated connection without a code", new Error("Connection terminated unexpectedly")],
    ["a pool timeout", new Error("timeout exceeded when trying to connect")],
    [
      "refused connections to every address",
      new AggregateError([withCode("ECONNREFUSED"), withCode("ECONNREFUSED")]),
    ],
  ])("recognizes %s", (_case, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ["a unique violation", queryFailed("23505")],
    ["a syntax error", queryFailed("42601")],
    ["a bug in the code", new TypeError("cannot read properties of undefined")],
    ["a value that is not an error", "ECONNREFUSED"],
    ["an aggregate of other errors", new AggregateError([new Error("boom")])],
  ])("does not treat %s as unavailability", (_case, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
});
