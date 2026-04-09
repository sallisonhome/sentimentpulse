import {
  pgTable,
  text,
  integer,
  timestamp,
  date,
  time,
  pgEnum,
  serial,
  boolean,
  json,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const eventTypeEnum = pgEnum("event_type", [
  "conference",
  "roadshow",
  "virtual",
  "other",
]);

export const sentimentEnum = pgEnum("sentiment", [
  "positive",
  "neutral",
  "negative",
]);

export const meetingFormatEnum = pgEnum("meeting_format", [
  "in_person",
  "virtual",
  "hybrid",
]);

export const egsStatusEnum = pgEnum("egs_status", [
  "launched",
  "announced",
  "under_discussion",
  "not_coming",
  "unknown",
]);

export const dealStatusEnum = pgEnum("deal_status", [
  "initial_outreach",
  "in_negotiation",
  "signed",
  "lost",
]);

export const topicCategoryEnum = pgEnum("topic_category", [
  "commercial",
  "product",
  "tech",
  "marketing",
  "operations",
]);

export const priorityEnum = pgEnum("priority", ["low", "medium", "high"]);

export const companyTypeEnum = pgEnum("company_type", [
  "publisher",
  "developer",
  "mixed",
]);

export const sourceTypeEnum = pgEnum("source_type", [
  "pasted_text",
  "google_doc",
  "pdf_file",
  "word_file",
  "other",
]);

export const parsingStatusEnum = pgEnum("parsing_status", [
  "pending",
  "success",
  "failed",
  "partially_parsed",
]);

export const sectionTypeEnum = pgEnum("section_type", [
  "event_header",
  "meeting_block",
  "game_block",
  "topic_block",
  "other",
]);

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "bd",
  "am",
  "viewer",
]);

// ─── Tables ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: userRoleEnum("role").notNull().default("am"),
  team: text("team"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  eventType: eventTypeEnum("event_type").notNull().default("conference"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  city: text("city"),
  country: text("country"),
  primaryOwnerUserId: integer("primary_owner_user_id").references(
    () => users.id
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const eventAttendees = pgTable("event_attendees", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  roleAtEvent: text("role_at_event"),
});

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  companyType: companyTypeEnum("company_type").notNull().default("developer"),
  region: text("region"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const meetings = pgTable("meetings", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  companyId: integer("company_id").references(() => companies.id),
  meetingDate: date("meeting_date"),
  startTime: time("start_time"),
  endTime: time("end_time"),
  location: text("location"),
  format: meetingFormatEnum("format").notNull().default("in_person"),
  overallSentiment: sentimentEnum("overall_sentiment")
    .notNull()
    .default("neutral"),
  summary: text("summary"),
  detailedNotes: text("detailed_notes"),
  followUpActions: text("follow_up_actions"),
  followUpOwnerUserId: integer("follow_up_owner_user_id").references(
    () => users.id
  ),
  followUpDueDate: date("follow_up_due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const meetingContacts = pgTable("meeting_contacts", {
  id: serial("id").primaryKey(),
  meetingId: integer("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  contactId: integer("contact_id")
    .notNull()
    .references(() => contacts.id),
  roleInMeeting: text("role_in_meeting"),
});

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  developerCompanyId: integer("developer_company_id").references(
    () => companies.id
  ),
  publisherCompanyId: integer("publisher_company_id").references(
    () => companies.id
  ),
  currentEgsStatus: egsStatusEnum("current_egs_status")
    .notNull()
    .default("unknown"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const meetingGames = pgTable("meeting_games", {
  id: serial("id").primaryKey(),
  meetingId: integer("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  gameId: integer("game_id")
    .notNull()
    .references(() => games.id),
  gameSpecificSentiment: sentimentEnum("game_specific_sentiment"),
  discussionSummary: text("discussion_summary"),
  dealStatus: dealStatusEnum("deal_status"),
  projectedLaunchTiming: text("projected_launch_timing"),
  keyQuotes: text("key_quotes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const platformTopics = pgTable("platform_topics", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: topicCategoryEnum("category").notNull().default("product"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const meetingTopics = pgTable("meeting_topics", {
  id: serial("id").primaryKey(),
  meetingId: integer("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  topicId: integer("topic_id")
    .notNull()
    .references(() => platformTopics.id),
  sentiment: sentimentEnum("sentiment").notNull().default("neutral"),
  feedbackSummary: text("feedback_summary"),
  requestOrBlocker: text("request_or_blocker"),
  priority: priorityEnum("priority").notNull().default("medium"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const eventExecutiveSummaries = pgTable("event_executive_summaries", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .unique()
    .references(() => events.id, { onDelete: "cascade" }),
  macroThemes: text("macro_themes"),
  highlights: text("highlights"),
  negatives: text("negatives"),
  recommendations: text("recommendations"),
  topOpportunities: json("top_opportunities").$type<string[]>(),
  topRisks: json("top_risks").$type<string[]>(),
  topActions: json("top_actions").$type<
    { action: string; owner: string; dueDate?: string }[]
  >(),
  generatedAt: timestamp("generated_at").defaultNow(),
  lastRefreshedAt: timestamp("last_refreshed_at").defaultNow(),
});

export const globalSummaries = pgTable("global_summaries", {
  id: serial("id").primaryKey(),
  snapshotDate: date("snapshot_date").notNull(),
  gamesSummary: json("games_summary"),
  topicsSummary: json("topics_summary"),
  keyRecommendations: text("key_recommendations"),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
});

export const sourceDocuments = pgTable("source_documents", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  sourceType: sourceTypeEnum("source_type").notNull(),
  originalFileName: text("original_file_name"),
  externalUrl: text("external_url"),
  storagePathOrId: text("storage_path_or_id"),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => users.id),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  parsingStatus: parsingStatusEnum("parsing_status")
    .notNull()
    .default("pending"),
  parsingLog: text("parsing_log"),
  rawTextExcerpt: text("raw_text_excerpt"),
  rawText: text("raw_text"),
});

export const parsedSections = pgTable("parsed_sections", {
  id: serial("id").primaryKey(),
  sourceDocumentId: integer("source_document_id")
    .notNull()
    .references(() => sourceDocuments.id, { onDelete: "cascade" }),
  sectionType: sectionTypeEnum("section_type").notNull().default("other"),
  linkedMeetingId: integer("linked_meeting_id").references(() => meetings.id),
  linkedGameId: integer("linked_game_id").references(() => games.id),
  linkedTopicId: integer("linked_topic_id").references(
    () => platformTopics.id
  ),
  sectionText: text("section_text"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Insert Schemas ───────────────────────────────────────────────────────────

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEventAttendeeSchema = createInsertSchema(
  eventAttendees
).omit({ id: true });
export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertContactSchema = createInsertSchema(contacts).omit({
  id: true,
  createdAt: true,
});
export const insertMeetingSchema = createInsertSchema(meetings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertMeetingContactSchema = createInsertSchema(
  meetingContacts
).omit({ id: true });
export const insertGameSchema = createInsertSchema(games).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertMeetingGameSchema = createInsertSchema(meetingGames).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPlatformTopicSchema = createInsertSchema(
  platformTopics
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMeetingTopicSchema = createInsertSchema(meetingTopics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEventExecutiveSummarySchema = createInsertSchema(
  eventExecutiveSummaries
).omit({ id: true, generatedAt: true, lastRefreshedAt: true });
export const insertGlobalSummarySchema = createInsertSchema(
  globalSummaries
).omit({ id: true, generatedAt: true });
export const insertSourceDocumentSchema = createInsertSchema(
  sourceDocuments
).omit({ id: true, uploadedAt: true });
export const insertParsedSectionSchema = createInsertSchema(
  parsedSections
).omit({ id: true, createdAt: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Event = typeof events.$inferSelect;
export type InsertEvent = z.infer<typeof insertEventSchema>;

export type EventAttendee = typeof eventAttendees.$inferSelect;
export type InsertEventAttendee = z.infer<typeof insertEventAttendeeSchema>;

export type Company = typeof companies.$inferSelect;
export type InsertCompany = z.infer<typeof insertCompanySchema>;

export type Contact = typeof contacts.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;

export type Meeting = typeof meetings.$inferSelect;
export type InsertMeeting = z.infer<typeof insertMeetingSchema>;

export type MeetingContact = typeof meetingContacts.$inferSelect;
export type InsertMeetingContact = z.infer<typeof insertMeetingContactSchema>;

export type Game = typeof games.$inferSelect;
export type InsertGame = z.infer<typeof insertGameSchema>;

export type MeetingGame = typeof meetingGames.$inferSelect;
export type InsertMeetingGame = z.infer<typeof insertMeetingGameSchema>;

export type PlatformTopic = typeof platformTopics.$inferSelect;
export type InsertPlatformTopic = z.infer<typeof insertPlatformTopicSchema>;

export type MeetingTopic = typeof meetingTopics.$inferSelect;
export type InsertMeetingTopic = z.infer<typeof insertMeetingTopicSchema>;

export type EventExecutiveSummary =
  typeof eventExecutiveSummaries.$inferSelect;
export type InsertEventExecutiveSummary = z.infer<
  typeof insertEventExecutiveSummarySchema
>;

export type GlobalSummary = typeof globalSummaries.$inferSelect;
export type InsertGlobalSummary = z.infer<typeof insertGlobalSummarySchema>;

export type SourceDocument = typeof sourceDocuments.$inferSelect;
export type InsertSourceDocument = z.infer<typeof insertSourceDocumentSchema>;

export type ParsedSection = typeof parsedSections.$inferSelect;
export type InsertParsedSection = z.infer<typeof insertParsedSectionSchema>;

// ─── Composite / View Types (used in frontend) ───────────────────────────────

export type MeetingWithDetails = Meeting & {
  company?: Company | null;
  contacts?: (MeetingContact & { contact: Contact })[];
  games?: (MeetingGame & { game: Game })[];
  topics?: (MeetingTopic & { topic: PlatformTopic })[];
  followUpOwner?: User | null;
};

export type EventWithStats = Event & {
  primaryOwner?: User | null;
  meetingCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  sourceDocumentCount: number;
  hasExecutiveSummary: boolean;
};
