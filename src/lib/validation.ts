import { z } from 'zod';

export const workLogSchema = z.object({
  project_id: z.string().uuid('Please select a valid project'),
  hours: z.number({
    required_error: 'Hours are required',
    invalid_type_error: 'Hours must be a number',
  })
    .positive('Hours must be greater than 0')
    .max(24, 'Hours cannot exceed 24 per entry'),
  task_type: z.array(z.string())
    .min(1, 'Please select at least one task type'),
  notes: z.string().max(500, 'Notes cannot exceed 500 characters').optional().nullable(),
});

export const expenseSchema = z.object({
  project_id: z.string().uuid('Please select a valid project'),
  description: z.string()
    .min(3, 'Description must be at least 3 characters')
    .max(200, 'Description cannot exceed 200 characters'),
  amount: z.number({
    required_error: 'Amount is required',
    invalid_type_error: 'Amount must be a number',
  })
    .positive('Amount must be greater than 0')
    .max(999999.99, 'Amount is too large'),
  receipt_skipped: z.boolean(),
});

export type WorkLogInput = z.infer<typeof workLogSchema>;
export type ExpenseInput = z.infer<typeof expenseSchema>;
