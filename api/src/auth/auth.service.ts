import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

/** What a validated token carries. `sub` is the user id, per JWT convention. */
export interface JwtPayload {
  sub: string;
  email: string;
}

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string };
}

@Injectable()
export class AuthService {
  /**
   * bcrypt work factor. 12 is the current sensible default: slow enough to make
   * offline cracking expensive, fast enough that a login is not noticeable.
   */
  private readonly SALT_ROUNDS = 12;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string): Promise<AuthResult> {
    const normalised = this.normaliseEmail(email);

    const existing = await this.prisma.user.findUnique({
      where: { email: normalised },
    });
    if (existing) {
      throw new ConflictException('That email is already registered');
    }

    const user = await this.prisma.user.create({
      data: {
        email: normalised,
        passwordHash: await bcrypt.hash(password, this.SALT_ROUNDS),
      },
    });

    return this.issueToken(user.id, user.email);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: this.normaliseEmail(email) },
    });

    // Compare against a dummy hash when the user does not exist, so the response
    // takes the same time either way and cannot be used to enumerate accounts.
    const hash = user?.passwordHash ?? (await this.dummyHash());
    const matches = await bcrypt.compare(password, hash);

    if (!user || !matches) {
      throw new UnauthorizedException('Email or password is incorrect');
    }

    return this.issueToken(user.id, user.email);
  }

  private async issueToken(id: string, email: string): Promise<AuthResult> {
    const payload: JwtPayload = { sub: id, email };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id, email },
    };
  }

  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** A real bcrypt hash of a throwaway value, so the timing matches a real compare. */
  private dummyHash(): Promise<string> {
    return bcrypt.hash('timing-equalising-placeholder', this.SALT_ROUNDS);
  }
}
