// SPDX-License-Identifier: Apache-2.0
// Saves text the portal already holds (an export the API produced, or JSON of what is on screen) as a file. No
// navigation, no inline script: a Blob URL on a temporary anchor with `download`, revoked right after.

export function saveText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
