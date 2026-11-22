import { BadRequestException, HttpStatus } from "@nestjs/common";

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

export function findDuplicateKey(json: string): string | null {
  const stack: (Set<string> | null)[] = [];

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (char === "{") {
      stack.push(new Set());
    } else if (char === "[") {
      stack.push(null);
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === '"') {
      const end = stringEnd(json, i);
      if (end === -1) {
        return null;
      }
      const keys = stack[stack.length - 1];
      if (keys && json[skipWhitespace(json, end + 1)] === ":") {
        let key: string;
        try {
          key = JSON.parse(json.slice(i, end + 1)) as string;
        } catch {
          return null;
        }
        if (keys.has(key)) {
          return key;
        }
        keys.add(key);
      }
      i = end;
    }
  }
  return null;
}

export function assertNoDuplicateKeys(rawBody: Buffer | undefined) {
  if (!rawBody) {
    return;
  }
  const key = findDuplicateKey(rawBody.toString("utf8"));
  if (key !== null) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      code: "duplicate_field",
      message: "Request body contains a repeated field",
    });
  }
}

function stringEnd(json: string, start: number) {
  for (let i = start + 1; i < json.length; i++) {
    if (json[i] === "\\") {
      i++;
    } else if (json[i] === '"') {
      return i;
    }
  }
  return -1;
}

function skipWhitespace(json: string, from: number) {
  let i = from;
  while (i < json.length && WHITESPACE.has(json[i])) {
    i++;
  }
  return i;
}
