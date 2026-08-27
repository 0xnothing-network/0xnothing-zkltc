const DECIMAL = /^\d+(?:\.\d+)?$/;

interface DecimalParts {
  integer: string;
  fraction: string;
}

function decimalParts(value: string): DecimalParts | undefined {
  if (!DECIMAL.test(value)) return undefined;
  const [rawInteger, rawFraction = ""] = value.split(".", 2);
  return {
    integer: rawInteger.replace(/^0+(?=\d)/, ""),
    fraction: rawFraction.replace(/0+$/, ""),
  };
}

function compareParts(left: DecimalParts, right: DecimalParts): number {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1;
  }
  if (left.integer !== right.integer) return left.integer < right.integer ? -1 : 1;

  const fractionLength = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(fractionLength, "0");
  const rightFraction = right.fraction.padEnd(fractionLength, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

/** Compare non-negative decimal strings without converting them to IEEE-754. */
export function compareDecimalStrings(left: string, right: string): number | undefined {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  return leftParts && rightParts ? compareParts(leftParts, rightParts) : undefined;
}

export function decimalMax(left: string, right: string): string {
  const comparison = compareDecimalStrings(left, right);
  return comparison !== undefined && comparison < 0 ? right : left;
}

export function decimalMin(left: string, right: string): string {
  const comparison = compareDecimalStrings(left, right);
  return comparison !== undefined && comparison > 0 ? right : left;
}
