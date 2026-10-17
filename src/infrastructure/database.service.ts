import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

@Injectable()
export class DatabaseService {
  constructor(private readonly orm: MikroORM<PostgreSqlDriver>) {}

  private bindParameters(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    const values: unknown[] = [];
    const query = sql.replace(/\$(\d+)/g, (_placeholder, position: string) => {
      const index = Number(position) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= params.length) {
        throw new Error(`SQL parameter $${position} has no matching value`);
      }
      values.push(params[index]);
      return '?';
    });
    return { sql: query, params: values };
  }

  execute<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const bound = this.bindParameters(sql, params);
    return this.orm.em.getConnection().execute<T[]>(bound.sql, bound.params);
  }

  transaction<T>(work: (execute: DatabaseService['execute']) => Promise<T>): Promise<T> {
    return this.orm.em.transactional(async (em) => {
      const execute = <R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<R[]> => {
        const bound = this.bindParameters(sql, params);
        return em.getConnection().execute<R[]>(bound.sql, bound.params, 'all', em.getTransactionContext());
      };
      return work(execute);
    });
  }
}
