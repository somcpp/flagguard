/**
 * Minimal unified-diff parser (the format of `git diff` and GitHub's
 * `application/vnd.github.diff`). Only tracks what risk analysis needs:
 * which files changed and which lines were added, with new-file line numbers.
 */

export interface AddedLine {
  /** 1-based line number in the new version of the file. */
  line: number;
  content: string;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: AddedLine[];
  removedCount: number;
  /** Hunks rendered back to text, used as LLM context. */
  patch: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(raw);
      current = {
        path: match?.[1] ?? "",
        status: "modified",
        added: [],
        removedCount: 0,
        patch: "",
      };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (!inHunk) {
      if (raw.startsWith("new file mode")) current.status = "added";
      else if (raw.startsWith("deleted file mode")) current.status = "deleted";
      else if (raw.startsWith("rename to ")) {
        current.status = "renamed";
        current.path = raw.slice("rename to ".length);
      } else if (raw.startsWith("+++ ")) {
        const target = raw.slice(4).trim();
        if (target !== "/dev/null") current.path = target.replace(/^b\//, "");
      }
    }

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      current.patch += raw + "\n";
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith("+")) {
      current.added.push({ line: newLine, content: raw.slice(1) });
      current.patch += `${String(newLine).padStart(4)} +${raw.slice(1)}\n`;
      newLine++;
    } else if (raw.startsWith("-")) {
      current.removedCount++;
      current.patch += `     -${raw.slice(1)}\n`;
    } else if (raw.startsWith(" ")) {
      current.patch += `${String(newLine).padStart(4)}  ${raw.slice(1)}\n`;
      newLine++;
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    }
  }
  return files.filter((f) => f.path !== "");
}
