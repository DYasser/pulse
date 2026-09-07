import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateMonitorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /**
   * http(s) only, and no localhost or bare hostnames: a monitor that can be pointed
   * at internal addresses turns this service into an SSRF vector, since the server
   * fetches whatever it is given.
   */
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: true,
  })
  @MaxLength(2048)
  url!: string;

  /** One minute floor - anything tighter is abusive to the target and pointless. */
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(86_400)
  intervalSec?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(599)
  expectedStatus?: number;

  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(30_000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;
}
