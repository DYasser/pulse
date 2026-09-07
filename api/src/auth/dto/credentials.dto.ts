import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CredentialsDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(255)
  email!: string;

  /**
   * Twelve characters rather than the customary eight: length is the only property
   * that reliably resists offline cracking. Capped because bcrypt silently ignores
   * anything past 72 bytes, which would otherwise make long passwords weaker than
   * they look.
   */
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(72, { message: 'Password must be at most 72 characters' })
  password!: string;
}
