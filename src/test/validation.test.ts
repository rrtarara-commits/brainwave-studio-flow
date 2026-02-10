import { describe, expect, it } from "vitest";
import { expenseSchema, workLogSchema } from "@/lib/validation";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("validation schemas", () => {
  describe("workLogSchema", () => {
    it("accepts valid input", () => {
      const result = workLogSchema.safeParse({
        project_id: VALID_UUID,
        hours: 4.5,
        task_type: ["Editing", "Review"],
        notes: "Cut pass and review notes",
      });

      expect(result.success).toBe(true);
    });

    it("rejects invalid project IDs", () => {
      const result = workLogSchema.safeParse({
        project_id: "not-a-uuid",
        hours: 2,
        task_type: ["Editing"],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe("Please select a valid project");
      }
    });

    it("enforces hour bounds and required fields", () => {
      const missingHours = workLogSchema.safeParse({
        project_id: VALID_UUID,
        task_type: ["Editing"],
      });
      expect(missingHours.success).toBe(false);

      const zeroHours = workLogSchema.safeParse({
        project_id: VALID_UUID,
        hours: 0,
        task_type: ["Editing"],
      });
      expect(zeroHours.success).toBe(false);
      if (!zeroHours.success) {
        expect(zeroHours.error.issues[0]?.message).toBe("Hours must be greater than 0");
      }

      const tooManyHours = workLogSchema.safeParse({
        project_id: VALID_UUID,
        hours: 25,
        task_type: ["Editing"],
      });
      expect(tooManyHours.success).toBe(false);
      if (!tooManyHours.success) {
        expect(tooManyHours.error.issues[0]?.message).toBe("Hours cannot exceed 24 per entry");
      }
    });

    it("requires at least one task type and limits note length", () => {
      const noTasks = workLogSchema.safeParse({
        project_id: VALID_UUID,
        hours: 1,
        task_type: [],
      });
      expect(noTasks.success).toBe(false);
      if (!noTasks.success) {
        expect(noTasks.error.issues[0]?.message).toBe("Please select at least one task type");
      }

      const longNotes = workLogSchema.safeParse({
        project_id: VALID_UUID,
        hours: 1,
        task_type: ["Editing"],
        notes: "a".repeat(501),
      });
      expect(longNotes.success).toBe(false);
      if (!longNotes.success) {
        expect(longNotes.error.issues[0]?.message).toBe("Notes cannot exceed 500 characters");
      }
    });
  });

  describe("expenseSchema", () => {
    it("accepts valid input", () => {
      const result = expenseSchema.safeParse({
        project_id: VALID_UUID,
        description: "Music licensing",
        amount: 120.45,
        receipt_skipped: false,
      });

      expect(result.success).toBe(true);
    });

    it("enforces description length", () => {
      const tooShort = expenseSchema.safeParse({
        project_id: VALID_UUID,
        description: "ab",
        amount: 10,
        receipt_skipped: false,
      });
      expect(tooShort.success).toBe(false);
      if (!tooShort.success) {
        expect(tooShort.error.issues[0]?.message).toBe("Description must be at least 3 characters");
      }

      const tooLong = expenseSchema.safeParse({
        project_id: VALID_UUID,
        description: "x".repeat(201),
        amount: 10,
        receipt_skipped: false,
      });
      expect(tooLong.success).toBe(false);
      if (!tooLong.success) {
        expect(tooLong.error.issues[0]?.message).toBe("Description cannot exceed 200 characters");
      }
    });

    it("enforces amount bounds", () => {
      const zeroAmount = expenseSchema.safeParse({
        project_id: VALID_UUID,
        description: "Expense",
        amount: 0,
        receipt_skipped: false,
      });
      expect(zeroAmount.success).toBe(false);
      if (!zeroAmount.success) {
        expect(zeroAmount.error.issues[0]?.message).toBe("Amount must be greater than 0");
      }

      const hugeAmount = expenseSchema.safeParse({
        project_id: VALID_UUID,
        description: "Large expense",
        amount: 1_000_000,
        receipt_skipped: false,
      });
      expect(hugeAmount.success).toBe(false);
      if (!hugeAmount.success) {
        expect(hugeAmount.error.issues[0]?.message).toBe("Amount is too large");
      }
    });
  });
});
