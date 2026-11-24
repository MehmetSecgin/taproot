import { z } from 'zod';
import { parseJson } from './parse-json.js';

export type JsonRecord = Record<string, unknown>;

const envelopeSchema = z.looseObject({ ok: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional(), meta: z.unknown().optional() });

const recordSchema = z.record(z.string(), z.unknown());
const recordListSchema = z.array(recordSchema);

const errorSchema = z.looseObject({ code: z.string(), message: z.string(), details: z.unknown().optional() });

export const doctorCheckSchema = z.looseObject({
  check: z.string(),
  status: z.string(),
  detail: z.string().optional(),
  code: z.string().optional(),
});

export type DoctorCheckOutput = z.infer<typeof doctorCheckSchema>;

const doctorDataSchema = z.looseObject({ checks: z.array(doctorCheckSchema) });

export function outputEnvelope(stdout: string): z.infer<typeof envelopeSchema> {
  return envelopeSchema.parse(parseJson(stdout));
}

export function outputData<Schema extends z.ZodType>(stdout: string, schema: Schema): z.infer<Schema> {
  return schema.parse(outputEnvelope(stdout).data);
}

export function outputDataRecord(stdout: string): JsonRecord {
  return outputData(stdout, recordSchema);
}

export function outputDataList(stdout: string): JsonRecord[] {
  return outputData(stdout, recordListSchema);
}

export function outputError(stdout: string): z.infer<typeof errorSchema> {
  return errorSchema.parse(outputEnvelope(stdout).error);
}

export function outputChecks(stdout: string): DoctorCheckOutput[] {
  return outputData(stdout, doctorDataSchema).checks;
}

export function outputCheckNamed(stdout: string, name: string): DoctorCheckOutput | undefined {
  return outputChecks(stdout).find((check) => check.check === name);
}
