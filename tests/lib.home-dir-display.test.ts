import { describe, expect, it } from "vitest";
import {
  replaceHomeDirWithTilde,
  replaceHomeDirWithTildeInDocument,
} from "../src/lib/home-dir-display.js";
import type { ReportDocument } from "../src/lib/report-document.js";

const HOME = "/Users/alice";

describe("replaceHomeDirWithTilde", () => {
  it("shows a path under home as ~/...", () => {
    expect(replaceHomeDirWithTilde("/Users/alice/.local/share/opencode/opencode.db", HOME)).toBe(
      "~/.local/share/opencode/opencode.db",
    );
  });

  it("shows the home dir itself as ~", () => {
    expect(replaceHomeDirWithTilde("/Users/alice", HOME)).toBe("~");
    expect(replaceHomeDirWithTilde("cwd=/Users/alice present=true", HOME)).toBe(
      "cwd=~ present=true",
    );
  });

  it("replaces every home path inside a longer line", () => {
    expect(
      replaceHomeDirWithTilde(
        "path=/Users/alice/a.json present=true | /Users/alice/.config/b.json (/Users/alice/c)",
        HOME,
      ),
    ).toBe("path=~/a.json present=true | ~/.config/b.json (~/c)");
  });

  it("leaves a lookalike folder that only starts with the home name alone", () => {
    expect(replaceHomeDirWithTilde("/Users/alicesmith/.config/opencode", HOME)).toBe(
      "/Users/alicesmith/.config/opencode",
    );
    expect(replaceHomeDirWithTilde("/Users/alice.old/x", HOME)).toBe("/Users/alice.old/x");
  });

  it("leaves a path outside home unchanged", () => {
    expect(replaceHomeDirWithTilde("/tmp/opencode/opencode.db", HOME)).toBe(
      "/tmp/opencode/opencode.db",
    );
    expect(replaceHomeDirWithTilde("/mnt/backup/Users/alice/x", HOME)).toBe(
      "/mnt/backup/Users/alice/x",
    );
  });

  it("ignores a trailing separator on the home dir", () => {
    expect(replaceHomeDirWithTilde("/home/bob/.config", "/home/bob/")).toBe("~/.config");
  });

  it("handles a Windows home dir", () => {
    expect(
      replaceHomeDirWithTilde(
        "path=C:\\Users\\alice\\.local\\share\\opencode\\opencode.db",
        "C:\\Users\\alice",
      ),
    ).toBe("path=~\\.local\\share\\opencode\\opencode.db");
    expect(replaceHomeDirWithTilde("C:\\Users\\alicesmith\\x", "C:\\Users\\alice")).toBe(
      "C:\\Users\\alicesmith\\x",
    );
  });

  it("does nothing when the home dir is empty or a filesystem root", () => {
    expect(replaceHomeDirWithTilde("/etc/hosts", "/")).toBe("/etc/hosts");
    expect(replaceHomeDirWithTilde("/etc/hosts", "")).toBe("/etc/hosts");
    expect(replaceHomeDirWithTilde("C:\\x", "C:\\")).toBe("C:\\x");
  });
});

describe("replaceHomeDirWithTildeInDocument", () => {
  it("replaces the home dir in every kind of block", () => {
    const document: ReportDocument = {
      heading: { line: "# /Users/alice/title", subtitle: "/Users/alice" },
      sections: [
        {
          id: "s",
          title: "paths:",
          blocks: [
            {
              kind: "lines",
              lines: ["- configPaths: /Users/alice/.config/opencode/opencode.json"],
            },
            { kind: "kv", rows: [{ key: "opencode.db", value: "path=/Users/alice/x.db" }] },
            {
              kind: "table",
              headers: ["path"],
              rows: [["/Users/alice/a"]],
              aligns: ["left"],
            },
            {
              kind: "quota",
              provider: "p",
              percentMode: "remaining",
              lines: ["/Users/alice/q"],
              rows: [{ label: "l", value: "v", notes: ["/Users/alice/n"] }],
            },
          ],
        },
      ],
    };

    expect(replaceHomeDirWithTildeInDocument(document, HOME)).toEqual({
      heading: { line: "# ~/title", subtitle: "~" },
      sections: [
        {
          id: "s",
          title: "paths:",
          blocks: [
            { kind: "lines", lines: ["- configPaths: ~/.config/opencode/opencode.json"] },
            { kind: "kv", rows: [{ key: "opencode.db", value: "path=~/x.db" }] },
            { kind: "table", headers: ["path"], rows: [["~/a"]], aligns: ["left"] },
            {
              kind: "quota",
              provider: "p",
              percentMode: "remaining",
              lines: ["~/q"],
              rows: [{ label: "l", value: "v", notes: ["~/n"] }],
            },
          ],
        },
      ],
    });
  });
});
