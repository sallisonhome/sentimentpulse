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
      is_dummy BOOLEAN NOT NULL DEFAULT FALSE,
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

async function seedDummyEvents() {
  log("Seeding dummy example events...");

  // Get user ID for attribution
  const userRows = await db.select().from(users);
  const userId = userRows[0]?.id ?? 1;

  // Dummy companies
  const [dc1] = await db.insert(companies).values([
    { name: "Acme Interactive", companyType: "developer", region: "NA", notes: "Example company \u2014 fictional" },
  ]).returning();
  const [dc2] = await db.insert(companies).values([
    { name: "Fjord Studios", companyType: "publisher", region: "EMEA", notes: "Example company \u2014 fictional" },
  ]).returning();

  // Dummy contacts
  const [dct1] = await db.insert(contacts).values([
    { companyId: dc1.id, name: "Jane Doe", title: "VP Publishing", notes: "Fictional contact" },
  ]).returning();
  const [dct2] = await db.insert(contacts).values([
    { companyId: dc2.id, name: "Erik Lindgren", title: "Head of BD", notes: "Fictional contact" },
  ]).returning();

  // Dummy games
  const [dg1] = await db.insert(games).values([
    { title: "Starfall Chronicles", developerCompanyId: dc1.id, publisherCompanyId: dc1.id, currentEgsStatus: "under_discussion", notes: "Example game \u2014 fictional" },
  ]).returning();
  const [dg2] = await db.insert(games).values([
    { title: "Frozen Tides", developerCompanyId: dc2.id, publisherCompanyId: dc2.id, currentEgsStatus: "announced", notes: "Example game \u2014 fictional" },
  ]).returning();

  // Dummy Event 1: E3 2025
  const [dummyE1] = await db.insert(events).values([
    { name: "[EXAMPLE] E3 2025 Partner Meetings", description: "Example event \u2014 E3 partner meetings at the LA Convention Center", eventType: "conference", startDate: "2025-06-10", endDate: "2025-06-13", city: "Los Angeles", country: "USA", primaryOwnerUserId: userId, isDummy: true },
  ]).returning();

  // Dummy Event 2: Nordic Game 2025
  const [dummyE2] = await db.insert(events).values([
    { name: "[EXAMPLE] Nordic Game 2025 Trip", description: "Example event \u2014 Nordic Game conference trip report", eventType: "conference", startDate: "2025-05-20", endDate: "2025-05-22", city: "Malm\u00f6", country: "Sweden", primaryOwnerUserId: userId, isDummy: true },
  ]).returning();

  // Attendees
  await db.insert(eventAttendees).values([
    { eventId: dummyE1.id, userId, roleAtEvent: "Lead BD" },
    { eventId: dummyE2.id, userId, roleAtEvent: "Lead AM" },
  ]);

  // Meetings
  const [dm1] = await db.insert(meetings).values([
    { eventId: dummyE1.id, companyId: dc1.id, meetingDate: "2025-06-11", startTime: "10:00", endTime: "10:45", location: "Meeting Room 4A, West Hall", format: "in_person", overallSentiment: "positive", summary: "Acme Interactive excited about bringing Starfall Chronicles to EGS. Revenue share terms praised. Requesting marketing co-promotion support for launch.", detailedNotes: "Jane Doe led the discussion. Acme has been evaluating EGS for 6 months. Very impressed with the 88/12 revenue split.", followUpActions: "Send marketing co-op proposal. Schedule follow-up call for July.", followUpOwnerUserId: userId, followUpDueDate: "2025-07-01" },
  ]).returning();
  const [dm2] = await db.insert(meetings).values([
    { eventId: dummyE1.id, companyId: dc2.id, meetingDate: "2025-06-12", startTime: "14:00", endTime: "14:30", location: "Lobby Lounge, JW Marriott", format: "in_person", overallSentiment: "neutral", summary: "Fjord Studios evaluating EGS for Frozen Tides but concerned about discoverability compared to Steam.", detailedNotes: "Erik was direct about their hesitation. They want hard numbers on conversion rates before committing.", followUpActions: "Prepare EGS conversion rate deck.", followUpOwnerUserId: userId, followUpDueDate: "2025-07-15" },
  ]).returning();
  const [dm3] = await db.insert(meetings).values([
    { eventId: dummyE2.id, companyId: dc2.id, meetingDate: "2025-05-21", startTime: "11:00", endTime: "11:45", location: "Scandic Hotel Conference Center", format: "in_person", overallSentiment: "positive", summary: "Fjord Studios now leaning positive on Frozen Tides for EGS if exclusivity terms are favorable.", detailedNotes: "Erik brought his CEO. They discussed a compromise at 60 days exclusivity with enhanced featuring.", followUpActions: "Draft 60-day exclusivity proposal.", followUpOwnerUserId: userId, followUpDueDate: "2025-06-05" },
  ]).returning();

  // Meeting contacts
  await db.insert(meetingContacts).values([
    { meetingId: dm1.id, contactId: dct1.id, roleInMeeting: "Lead" },
    { meetingId: dm2.id, contactId: dct2.id, roleInMeeting: "Lead" },
    { meetingId: dm3.id, contactId: dct2.id, roleInMeeting: "Lead" },
  ]);

  // Meeting games
  await db.insert(meetingGames).values([
    { meetingId: dm1.id, gameId: dg1.id, gameSpecificSentiment: "positive", discussionSummary: "Starfall Chronicles confirmed interested in EGS launch.", dealStatus: "in_negotiation", projectedLaunchTiming: "Q1 2026" },
    { meetingId: dm2.id, gameId: dg2.id, gameSpecificSentiment: "neutral", discussionSummary: "Frozen Tides still evaluating. Data request pending.", dealStatus: "initial_outreach" },
    { meetingId: dm3.id, gameId: dg2.id, gameSpecificSentiment: "positive", discussionSummary: "Frozen Tides moving toward EGS. 60-day exclusivity discussed.", dealStatus: "in_negotiation", projectedLaunchTiming: "Q3 2025" },
  ]);

  // Get topic IDs
  const allTopics = await db.select().from(platformTopics);
  const revShareTopic = allTopics.find(t => t.name.includes("Revenue Share"));
  const discoveryTopic = allTopics.find(t => t.name.includes("Discovery"));
  const marketingTopic = allTopics.find(t => t.name.includes("User Acquisition"));

  if (revShareTopic && discoveryTopic && marketingTopic) {
    await db.insert(meetingTopics).values([
      { meetingId: dm1.id, topicId: revShareTopic.id, sentiment: "positive", feedbackSummary: "88/12 split praised. Launch bonus discussed.", priority: "high" },
      { meetingId: dm1.id, topicId: marketingTopic.id, sentiment: "positive", feedbackSummary: "Marketing co-op requested and viewed as a strong differentiator.", requestOrBlocker: "Needs co-marketing proposal", priority: "high" },
      { meetingId: dm2.id, topicId: discoveryTopic.id, sentiment: "negative", feedbackSummary: "Discoverability concerns \u2014 previous titles underperformed on EGS.", requestOrBlocker: "Need conversion rate data", priority: "high" },
      { meetingId: dm3.id, topicId: revShareTopic.id, sentiment: "positive", feedbackSummary: "Exclusivity window compromise at 60 days with enhanced featuring.", priority: "high" },
    ]);
  }

  // Source documents
  await db.insert(sourceDocuments).values([
    { eventId: dummyE1.id, sourceType: "pasted_text", uploadedByUserId: userId, parsingStatus: "success", parsingLog: "AI extraction complete. Meetings: 2 \u00b7 Companies: 2 \u00b7 Contacts: 2 \u00b7 Games: 2 \u00b7 Topics: 3", rawTextExcerpt: "E3 2025 Trip Report\n\n### Meeting: Acme Interactive (Jane Doe)\nSentiment: Positive..." },
    { eventId: dummyE2.id, sourceType: "pasted_text", uploadedByUserId: userId, parsingStatus: "success", parsingLog: "AI extraction complete. Meetings: 1 \u00b7 Companies: 1 \u00b7 Contacts: 1 \u00b7 Games: 1 \u00b7 Topics: 1", rawTextExcerpt: "Nordic Game 2025 Trip Report\n\n### Meeting: Fjord Studios (Erik Lindgren)\nSentiment: Positive..." },
  ]);

  // Executive summary for dummy E1
  await db.insert(eventExecutiveSummaries).values([
    {
      eventId: dummyE1.id,
      macroThemes: "Mixed signals at E3: indie developers receptive to EGS revenue share, but mid-tier publishers still cautious about discoverability.",
      highlights: "Acme Interactive strongly interested in launching Starfall Chronicles on EGS. 88/12 revenue share praised.",
      negatives: "Fjord Studios skeptical about EGS conversion rates vs Steam.",
      recommendations: "1. Prepare EGS conversion/wishlist data deck. 2. Develop co-marketing proposal template. 3. Schedule data-sharing session with Fjord.",
      topOpportunities: ["Starfall Chronicles (Acme) \u2014 Q1 2026", "Frozen Tides (Fjord) \u2014 needs data"],
      topRisks: ["Fjord may stay Steam-only", "Co-marketing budget needs approval"],
      topActions: [
        { action: "Send co-marketing proposal to Acme", owner: "EGS Team", dueDate: "2025-07-01" },
        { action: "Prepare conversion rate deck for Fjord", owner: "EGS Team", dueDate: "2025-07-15" },
      ],
    },
  ]);

  log("Dummy example events seeded");
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

  // Seed 2 dummy example events with full data
  await seedDummyEvents();

  log("Seed complete");
}

async function addMissingColumns() {
  // Add is_dummy column to events if it doesn't exist (upgrade path)
  await db.execute(sql`
    DO $$ BEGIN
      ALTER TABLE events ADD COLUMN IF NOT EXISTS is_dummy BOOLEAN NOT NULL DEFAULT FALSE;
    EXCEPTION WHEN duplicate_column THEN NULL; END $$;
  `);
}

export async function runMigrations() {
  log("Running migrations...");
  await createTablesIfNotExist();
  await addMissingColumns();
  log("Tables ready");
  await seedIfEmpty();
}
