import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  dbName: process.env.DATABASE_NAME ?? 'wagering',
  user: process.env.DATABASE_USER ?? 'wagering',
  password: process.env.DATABASE_PASSWORD ?? 'wagering',
  entities: [],
  discovery: { warnWhenNoEntities: false },
  preferTs: true,
  migrations: {
    path: './dist/src/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
  },
  extensions: [Migrator],
});
