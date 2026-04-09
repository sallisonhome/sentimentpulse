/**
 * Runs Drizzle migrations and seeds initial data if the DB is empty.
 * Called once at server startup.
 */
import { db } from "./db";
import {
  users, events, eventAttendees, companies, contacts,
  meetings, meetingContacts, games, meetingGames,
  platformTopics, meetingTopics, eventExecutiveSummaries,
  sourceDocuments,
} from "@shared/schema";
import { sql, count } from "drizzle-orm";

function log(msg: string) {
  console.log(`${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })} [migrate] ${msg}`);
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = ${tableName}
    )
  `);
  return (result.rows[0] as any).exists === true;
}

async function createTablesIfNotExist() {
  // Create enums
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE event_type AS ENUM ('conference','roadshow','virtual','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE sentiment AS ENUM ('positive','neutral','negative');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE meeting_format AS ENUM ('in_person','virtual','hybrid');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE egs_status AS ENUM ('launched','announced','under_discussion','not_coming','unknown');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE deal_status AS ENUM ('initial_outreach','in_negotiation','signed','lost');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE topic_category AS ENUM ('commercial','product','tech','marketing','operations');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE priority AS ENUM ('low','medium','high');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE company_type AS ENUM ('publisher','developer','mixed');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE source_type AS ENUM ('pasted_text','google_doc','pdf_file','word_file','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE parsing_status AS ENUM ('pending','success','failed','partially_parsed');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE section_type AS ENUM ('event_header','meeting_block','game_block','topic_block','other');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE user_role AS ENUM ('admin','bd','am','viewer');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  // Create tables
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role user_role NOT NULL DEFAULT 'am',
      team TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      event_type event_type NOT NULL DEFAULT 'conference',
      start_date DATE,
      end_date DATE,
      city TEXT,
      country TEXT,
      primary_owner_user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_attendees (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role_at_event TEXT
    );

    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      company_type company_type NOT NULL DEFAULT 'developer',
      region TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      title TEXT,
      email TEXT,
      phone TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      company_id INTEGER REFERENCES companies(id),
      meeting_date DATE,
      start_time TIME,
      end_time TIME,
      location TEXT,
      format meeting_format NOT NULL DEFAULT 'in_person',
      overall_sentiment sentiment NOT NULL DEFAULT 'neutral',
      summary TEXT,
      detailed_notes TEXT,
      follow_up_actions TEXT,
      follow_up_owner_user_id INTEGER REFERENCES users(id),
      follow_up_due_date DATE,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_contacts (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES contacts(id),
      role_in_meeting TEXT
    );

    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      developer_company_id INTEGER REFERENCES companies(id),
      publisher_company_id INTEGER REFERENCES companies(id),
      current_egs_status egs_status NOT NULL DEFAULT 'unknown',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_games (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id),
      game_specific_sentiment sentiment,
      discussion_summary TEXT,
      deal_status deal_status,
      projected_launch_timing TEXT,
      key_quotes TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_topics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category topic_category NOT NULL DEFAULT 'product',
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_topics (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      topic_id INTEGER NOT NULL REFERENCES platform_topics(id),
      sentiment sentiment NOT NULL DEFAULT 'neutral',
      feedback_summary TEXT,
      request_or_blocker TEXT,
      priority priority NOT NULL DEFAULT 'medium',
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_executive_summaries (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
      macro_themes TEXT,
      highlights TEXT,
      negatives TEXT,
      recommendations TEXT,
      top_opportunities JSON,
      top_risks JSON,
      top_actions JSON,
      generated_at TIMESTAMP DEFAULT NOW(),
      last_refreshed_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS global_summaries (
      id SERIAL PRIMARY KEY,
      snapshot_date DATE NOT NULL,
      games_summary JSON,
      topics_summary JSON,
      key_recommendations TEXT,
      generated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_documents (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      source_type source_type NOT NULL,
      original_file_name TEXT,
      external_url TEXT,
      storage_path_or_id TEXT,
      uploaded_by_user_id INTEGER REFERENCES users(id),
      uploaded_at TIMESTAMP DEFAULT NOW() NOT NULL,
      parsing_status parsing_status NOT NULL DEFAULT 'pending',
      parsing_log TEXT,
      raw_text_excerpt TEXT,
      raw_text TEXT
    );

    CREATE TABLE IF NOT EXISTS parsed_sections (
      id SERIAL PRIMARY KEY,
      source_document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
      section_type section_type NOT NULL DEFAULT 'other',
      linked_meeting_id INTEGER REFERENCES meetings(id),
      linked_game_id INTEGER REFERENCES games(id),
      linked_topic_id INTEGER REFERENCES platform_topics(id),
      section_text TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `);
}

async function seedIfEmpty() {
  // Only seed platform topics — these are required app lookup data.
  // We check topics not users, so a truncate + restart won't re-create fake demo data.
  const topicCount = await db.select({ count: count() }).from(platformTopics);
  if (Number(topicCount[0].count) > 0) {
    log("DB already seeded — skipping seed");
    return;
  }

  log("Seeding initial data...");

  // Seed a default user so the app has someone to attribute uploads to
  const existingUsers = await db.select({ count: count() }).from(users);
  if (Number(existingUsers[0].count) === 0) {
    await db.insert(users).values([
      { name: "EGS Team", email: "egs.team@epicgames.com", role: "admin", team: "EGS Business Development" },
    ]);
  }

  // Platform topics — required for AI parser topic matching
  await db.insert(platformTopics).values([
    { name: "Revenue Share / Commercial Terms", category: "commercial", description: "88/12 split discussion, MFN clauses, launch bonuses" },
    { name: "Discovery & Featuring", category: "product", description: "Store front visibility, editorial featuring, search ranking" },
    { name: "Tools & SDK", category: "tech", description: "EOS integration complexity, overlay features, achievement system" },
    { name: "Payments & Reporting", category: "operations", description: "Analytics dashboard, payment timelines, currency support" },
    { name: "User Acquisition & Marketing", category: "marketing", description: "Free games program, launch marketing support, UA budget" },
  ]);

  log("Seed complete");
}

export async function runMigrations() {
  log("Running migrations...");
  await createTablesIfNotExist();
  log("Tables ready");
  await seedIfEmpty();
}
