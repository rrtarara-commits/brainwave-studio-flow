import { describe, expect, it } from "vitest";
import {
  analyzeFilename,
  extractVersionFromFilename,
  generateStandardFilename,
  getNextVersion,
  isStandardFilename,
  isValidProjectCode,
} from "@/lib/filename-utils";

describe("filename-utils", () => {
  describe("isValidProjectCode", () => {
    it("accepts 3-4 letters followed by 3 digits", () => {
      expect(isValidProjectCode("ABC123")).toBe(true);
      expect(isValidProjectCode("ABCD123")).toBe(true);
      expect(isValidProjectCode("abc123")).toBe(true);
    });

    it("rejects invalid formats", () => {
      expect(isValidProjectCode("AB123")).toBe(false);
      expect(isValidProjectCode("ABCDE123")).toBe(false);
      expect(isValidProjectCode("ABC12")).toBe(false);
      expect(isValidProjectCode("123ABC")).toBe(false);
    });
  });

  describe("extractVersionFromFilename", () => {
    it("extracts versions from supported patterns", () => {
      expect(extractVersionFromFilename("my-cut_v2.mp4")).toBe(2);
      expect(extractVersionFromFilename("my-cut version 12.mp4")).toBe(12);
      expect(extractVersionFromFilename("my-cut-rev7.mp4")).toBe(7);
      expect(extractVersionFromFilename("my-cut_r4.mp4")).toBe(4);
    });

    it("returns null when no version marker is present", () => {
      expect(extractVersionFromFilename("final_export.mp4")).toBeNull();
    });
  });

  describe("isStandardFilename", () => {
    it("matches the standard format case-insensitively", () => {
      expect(isStandardFilename("ABC123_v3.mov", "ABC123")).toBe(true);
      expect(isStandardFilename("abc123_v10.MP4", "ABC123")).toBe(true);
    });

    it("rejects non-standard names", () => {
      expect(isStandardFilename("ABC123-v3.mov", "ABC123")).toBe(false);
      expect(isStandardFilename("ABC123_vx.mov", "ABC123")).toBe(false);
    });
  });

  describe("generateStandardFilename", () => {
    it("uppercases project code and normalizes extension", () => {
      expect(generateStandardFilename("abc123", 5, "mp4")).toBe("ABC123_v5.mp4");
      expect(generateStandardFilename("abcd123", 1, ".mov")).toBe("ABCD123_v1.mov");
    });
  });

  describe("analyzeFilename", () => {
    it("returns no suggestion when project code is missing or invalid", () => {
      expect(analyzeFilename("clip_v2.mp4", null)).toEqual({
        isStandard: false,
        currentName: "clip_v2.mp4",
        suggestedName: null,
        extension: ".mp4",
        extractedVersion: null,
        hasProjectCode: false,
      });

      expect(analyzeFilename("clip_v2.mp4", "BAD")).toEqual({
        isStandard: false,
        currentName: "clip_v2.mp4",
        suggestedName: null,
        extension: ".mp4",
        extractedVersion: null,
        hasProjectCode: false,
      });
    });

    it("identifies already-standard names", () => {
      expect(analyzeFilename("ABC123_v2.mp4", "ABC123")).toEqual({
        isStandard: true,
        currentName: "ABC123_v2.mp4",
        suggestedName: null,
        extension: ".mp4",
        extractedVersion: 2,
        hasProjectCode: true,
      });
    });

    it("suggests standardized names and defaults to v1 when no version exists", () => {
      expect(analyzeFilename("client-cut_r4_final.mp4", "ABC123")).toEqual({
        isStandard: false,
        currentName: "client-cut_r4_final.mp4",
        suggestedName: "ABC123_v4.mp4",
        extension: ".mp4",
        extractedVersion: 4,
        hasProjectCode: true,
      });

      expect(analyzeFilename("client-cut-final.mp4", "ABCD123")).toEqual({
        isStandard: false,
        currentName: "client-cut-final.mp4",
        suggestedName: "ABCD123_v1.mp4",
        extension: ".mp4",
        extractedVersion: null,
        hasProjectCode: true,
      });
    });
  });

  describe("getNextVersion", () => {
    it("returns next highest version from standard filenames only", () => {
      const filenames = [
        "ABC123_v1.mp4",
        "ABC123_v7.mp4",
        "abc123_v4.mov",
        "ABC123-final.mp4",
        "XYZ999_v10.mp4",
      ];

      expect(getNextVersion(filenames, "ABC123")).toBe(8);
    });

    it("starts at version 1 when no prior versions exist", () => {
      expect(getNextVersion(["random.mp4", "another-file.mov"], "ABC123")).toBe(1);
    });
  });
});
