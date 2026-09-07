import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import type { AuthResult } from './auth.service';
import { CredentialsDto } from './dto/credentials.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { RequestUser } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Five an hour per address. Unbounded registration means unbounded monitors,
  // which means unbounded outbound probe traffic attributable to this host.
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @Post('register')
  register(@Body() dto: CredentialsDto): Promise<AuthResult> {
    return this.auth.register(dto.email, dto.password);
  }

  // Ten a minute. Each attempt costs a cost-12 bcrypt by design, so this is both
  // a brute-force limit and the thing standing between the login route and a
  // trivial CPU exhaustion attack.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  // 200 rather than 201: logging in does not create anything.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: CredentialsDto): Promise<AuthResult> {
    return this.auth.login(dto.email, dto.password);
  }

  /** Lets a client confirm a stored token is still good. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: RequestUser): RequestUser {
    return user;
  }
}
