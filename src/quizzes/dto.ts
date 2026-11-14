import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID,
  Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class QuestionDto {
  @IsString() @trim() @Length(1, 1000)
  prompt: string;

  @IsArray() @ArrayMinSize(4) @ArrayMaxSize(4)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value))
  @IsString({ each: true }) @Length(1, 500, { each: true })
  options: string[];

  @Type(() => Number) @IsInt() @Min(0) @Max(3)
  correctIndex: number;
}

export class CreateQuizDto {
  @IsString() @trim() @Length(1, 200)
  title: string;

  @IsOptional() @IsString() @trim() @MaxLength(2000)
  description?: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => QuestionDto)
  questions: QuestionDto[];
}

export class AssignQuizDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ArrayUnique()
  @IsUUID('all', { each: true })
  studentIds: string[];
}

export class AnswerDto {
  @IsUUID('all')
  questionId: string;

  @IsUUID('all')
  optionId: string;
}

export class SubmitAttemptDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => AnswerDto)
  answers: AnswerDto[];
}
