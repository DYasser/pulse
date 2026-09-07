import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Rejects a request without a valid bearer token. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
