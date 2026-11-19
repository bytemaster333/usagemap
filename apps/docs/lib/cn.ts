// SPDX-License-Identifier: Apache-2.0
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
