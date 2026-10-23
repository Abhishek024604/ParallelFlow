import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import { fieldErrors, validationFailed } from './errors.js';

// Zod validation (doc 05 §5.5 step 6, doc 10 §10.5). Schemas live in @parallelflow/contracts.
//   @Post() create(@Body(new ZodPipe(CreateThingSchema)) body: CreateThing) { … }

@Injectable()
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) throw validationFailed(fieldErrors(result.error.issues));
    return result.data;
  }
}
