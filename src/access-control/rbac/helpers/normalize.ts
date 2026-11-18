import type { TransformFnParams } from "class-transformer";

const normalize = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

// имя роли, разрешения или действия сравнивается после обрезки и приведения к нижнему регистру
export const normalizeName = ({ value }: TransformFnParams) => normalize(value);

export const normalizeNames = ({ value }: TransformFnParams) =>
  Array.isArray(value) ? value.map(normalize) : value;

export const trimText = ({ value }: TransformFnParams) =>
  typeof value === "string" ? value.trim() : value;
