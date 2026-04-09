import { eq, sql, desc } from "drizzle-orm";
import { db } from "./db";
import {
  users, events, eventAttendees, companies, contacts,
  meetings, meetingContacts, games, meetingGames,
  platformTopics, meetingTopics, eventExecutiveSummaries,
  globalSummaries, sourceDocuments, parsedSections,
  type User, type InsertUser,
  type Event, type InsertEvent, type EventWithStats,
  type EventAttendee, type InsertEventAttendee,
  type Company, type InsertCompany,
  type Contact, type InsertContact,
  type Meeting, type InsertMeeting, type MeetingWithDetails,
  type MeetingContact, type InsertMeetingContact,
  type Game, type InsertGame,
  type MeetingGame, type InsertMeetingGame,
  type PlatformTopic, type InsertPlatformTopic,
  type MeetingTopic, type InsertMeetingTopic,
  type EventExecutiveSummary, type InsertEventExecutiveSummary,
  type GlobalSummary, type InsertGlobalSummary,
  type SourceDocument, type InsertSourceDocument,
  type ParsedSection, type InsertParsedSection,
} from "@shared/schema";
import type { IStorage } from "./storage";

export class DatabaseStorage implements IStorage {

  // ── Users ──────────────────────────────────────────────────────────────────

  async getUsers(): Promise<User[]> {
    return db.select().from(users);
  }

  async getUserById(id: number): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0];
  }

  async createUser(data: InsertUser): Promise<User> {
    const rows = await db.insert(users).values(data).returning();
    return rows[0];
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  async getEvents(): Promise<EventWithStats[]> {
    const allEvents = await db.select().from(events).orderBy(desc(events.startDate));
    return Promise.all(allEvents.map(e => this.getEventWithStats(e.id) as Promise<EventWithStats>));
  }

  async getEventById(id: number): Promise<Event | undefined> {
    const rows = await db.select().from(events).where(eq(events.id, id));
    return rows[0];
  }

  async getEventWithStats(id: number): Promise<EventWithStats | undefined> {
    const rows = await db.select().from(events).where(eq(events.id, id));
    const event = rows[0];
    if (!event) return undefined;

    const eventMeetings = await db.select().from(meetings).where(eq(meetings.eventId, id));
    const docs = await db.select().from(sourceDocuments).where(eq(sourceDocuments.eventId, id));
    const summaries = await db.select().from(eventExecutiveSummaries).where(eq(eventExecutiveSummaries.eventId, id));
    const owner = event.primaryOwnerUserId
      ? (await db.select().from(users).where(eq(users.id, event.primaryOwnerUserId)))[0] ?? null
      : null;

    return {
      ...event,
      primaryOwner: owner,
      meetingCount: eventMeetings.length,
      positiveCount: eventMeetings.filter(m => m.overallSentiment === "positive").length,
      neutralCount: eventMeetings.filter(m => m.overallSentiment === "neutral").length,
      negativeCount: eventMeetings.filter(m => m.overallSentiment === "negative").length,
      sourceDocumentCount: docs.length,
      hasExecutiveSummary: summaries.length > 0,
    };
  }

  async createEvent(data: InsertEvent): Promise<Event> {
    const rows = await db.insert(events).values(data).returning();
    return rows[0];
  }

  async updateEvent(id: number, data: Partial<InsertEvent>): Promise<Event> {
    const rows = await db.update(events)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(events.id, id))
      .returning();
    if (!rows[0]) throw new Error(`Event ${id} not found`);
    return rows[0];
  }

  async deleteEvent(id: number): Promise<void> {
    await db.delete(events).where(eq(events.id, id));
  }

  // ── EventAttendees ─────────────────────────────────────────────────────────

  async getEventAttendees(eventId: number): Promise<(EventAttendee & { user: User })[]> {
    const rows = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventId));
    const result: (EventAttendee & { user: User })[] = [];
    for (const ea of rows) {
      const userRows = await db.select().from(users).where(eq(users.id, ea.userId));
      if (userRows[0]) result.push({ ...ea, user: userRows[0] });
    }
    return result;
  }

  async addEventAttendee(data: InsertEventAttendee): Promise<EventAttendee> {
    const rows = await db.insert(eventAttendees).values(data).returning();
    return rows[0];
  }

  // ── Companies ──────────────────────────────────────────────────────────────

  async getCompanies(): Promise<Company[]> {
    return db.select().from(companies);
  }

  async getCompanyById(id: number): Promise<Company | undefined> {
    const rows = await db.select().from(companies).where(eq(companies.id, id));
    return rows[0];
  }

  async createCompany(data: InsertCompany): Promise<Company> {
    const rows = await db.insert(companies).values(data).returning();
    return rows[0];
  }

  async updateCompany(id: number, data: Partial<InsertCompany>): Promise<Company> {
    const rows = await db.update(companies)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(companies.id, id))
      .returning();
    if (!rows[0]) throw new Error(`Company ${id} not found`);
    return rows[0];
  }

  // ── Contacts ───────────────────────────────────────────────────────────────

  async getContactsByCompany(companyId: number): Promise<Contact[]> {
    return db.select().from(contacts).where(eq(contacts.companyId, companyId));
  }

  async createContact(data: InsertContact): Promise<Contact> {
    const rows = await db.insert(contacts).values(data).returning();
    return rows[0];
  }

  // ── Meetings ───────────────────────────────────────────────────────────────

  async getMeetingsByEvent(eventId: number): Promise<MeetingWithDetails[]> {
    const rows = await db.select().from(meetings).where(eq(meetings.eventId, eventId));
    return Promise.all(rows.map(m => this._enrichMeeting(m)));
  }

  async getMeetingById(id: number): Promise<MeetingWithDetails | undefined> {
    const rows = await db.select().from(meetings).where(eq(meetings.id, id));
    if (!rows[0]) return undefined;
    return this._enrichMeeting(rows[0]);
  }

  private async _enrichMeeting(m: Meeting): Promise<MeetingWithDetails> {
    const company = m.companyId
      ? (await db.select().from(companies).where(eq(companies.id, m.companyId)))[0] ?? null
      : null;

    const mcRows = await db.select().from(meetingContacts).where(eq(meetingContacts.meetingId, m.id));
    const mContacts = await Promise.all(mcRows.map(async mc => {
      const c = (await db.select().from(contacts).where(eq(contacts.id, mc.contactId)))[0];
      return c ? { ...mc, contact: c } : null;
    }));

    const mgRows = await db.select().from(meetingGames).where(eq(meetingGames.meetingId, m.id));
    const mGames = await Promise.all(mgRows.map(async mg => {
      const g = (await db.select().from(games).where(eq(games.id, mg.gameId)))[0];
      return g ? { ...mg, game: g } : null;
    }));

    const mtRows = await db.select().from(meetingTopics).where(eq(meetingTopics.meetingId, m.id));
    const mTopics = await Promise.all(mtRows.map(async mt => {
      const t = (await db.select().from(platformTopics).where(eq(platformTopics.id, mt.topicId)))[0];
      return t ? { ...mt, topic: t } : null;
    }));

    const followUpOwner = m.followUpOwnerUserId
      ? (await db.select().from(users).where(eq(users.id, m.followUpOwnerUserId)))[0] ?? null
      : null;

    return {
      ...m,
      company,
      contacts: mContacts.filter(Boolean) as any,
      games: mGames.filter(Boolean) as any,
      topics: mTopics.filter(Boolean) as any,
      followUpOwner,
    };
  }

  async createMeeting(data: InsertMeeting): Promise<Meeting> {
    const rows = await db.insert(meetings).values(data).returning();
    return rows[0];
  }

  async updateMeeting(id: number, data: Partial<InsertMeeting>): Promise<Meeting> {
    const rows = await db.update(meetings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(meetings.id, id))
      .returning();
    if (!rows[0]) throw new Error(`Meeting ${id} not found`);
    return rows[0];
  }

  async deleteMeeting(id: number): Promise<void> {
    await db.delete(meetings).where(eq(meetings.id, id));
  }

  // ── MeetingContacts ────────────────────────────────────────────────────────

  async addMeetingContact(data: InsertMeetingContact): Promise<MeetingContact> {
    const rows = await db.insert(meetingContacts).values(data).returning();
    return rows[0];
  }

  // ── Games ──────────────────────────────────────────────────────────────────

  async getGames(): Promise<Game[]> {
    return db.select().from(games);
  }

  async getGameById(id: number): Promise<Game | undefined> {
    const rows = await db.select().from(games).where(eq(games.id, id));
    return rows[0];
  }

  async createGame(data: InsertGame): Promise<Game> {
    const rows = await db.insert(games).values(data).returning();
    return rows[0];
  }

  async updateGame(id: number, data: Partial<InsertGame>): Promise<Game> {
    const rows = await db.update(games)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(games.id, id))
      .returning();
    if (!rows[0]) throw new Error(`Game ${id} not found`);
    return rows[0];
  }

  async getGamesWithTouchpoints(): Promise<(Game & { touchpointCount: number; sentiments: string[]; events: string[] })[]> {
    const allGames = await db.select().from(games);
    return Promise.all(allGames.map(async g => {
      const mgRows = await db.select().from(meetingGames).where(eq(meetingGames.gameId, g.id));
      const sentiments = mgRows.map(mg => mg.gameSpecificSentiment).filter(Boolean) as string[];
      const eventNames: string[] = [];
      for (const mg of mgRows) {
        const mtg = (await db.select().from(meetings).where(eq(meetings.id, mg.meetingId)))[0];
        if (mtg) {
          const ev = (await db.select().from(events).where(eq(events.id, mtg.eventId)))[0];
          if (ev && !eventNames.includes(ev.name)) eventNames.push(ev.name);
        }
      }
      return { ...g, touchpointCount: mgRows.length, sentiments, events: eventNames };
    }));
  }

  // ── MeetingGames ───────────────────────────────────────────────────────────

  async getMeetingGames(meetingId: number): Promise<(MeetingGame & { game: Game })[]> {
    const rows = await db.select().from(meetingGames).where(eq(meetingGames.meetingId, meetingId));
    const result: (MeetingGame & { game: Game })[] = [];
    for (const mg of rows) {
      const g = (await db.select().from(games).where(eq(games.id, mg.gameId)))[0];
      if (g) result.push({ ...mg, game: g });
    }
    return result;
  }

  async addMeetingGame(data: InsertMeetingGame): Promise<MeetingGame> {
    const rows = await db.insert(meetingGames).values(data).returning();
    return rows[0];
  }

  async removeMeetingGame(id: number): Promise<void> {
    await db.delete(meetingGames).where(eq(meetingGames.id, id));
  }

  async getMeetingGameEntries(gameId: number): Promise<import("./storage").GameEntry[]> {
    const mgRows = await db.select().from(meetingGames).where(eq(meetingGames.gameId, gameId));
    const result: import("./storage").GameEntry[] = [];
    for (const mg of mgRows) {
      const mtg = (await db.select().from(meetings).where(eq(meetings.id, mg.meetingId)))[0];
      if (!mtg) continue;
      const company = (await db.select().from(companies).where(eq(companies.id, mtg.companyId)))[0];
      const ev = (await db.select().from(events).where(eq(events.id, mtg.eventId)))[0];
      if (!ev) continue;
      result.push({
        meetingGameId: mg.id,
        gameSpecificSentiment: mg.gameSpecificSentiment ?? null,
        discussionSummary: mg.discussionSummary ?? null,
        dealStatus: mg.dealStatus ?? null,
        projectedLaunchTiming: mg.projectedLaunchTiming ?? null,
        keyQuotes: mg.keyQuotes ?? null,
        meetingId: mtg.id,
        meetingDate: mtg.meetingDate ?? null,
        meetingLocation: mtg.location ?? null,
        companyName: company?.name ?? "Unknown",
        eventId: ev.id,
        eventName: ev.name,
      });
    }
    return result;
  }

  // ── PlatformTopics ─────────────────────────────────────────────────────────

  async getPlatformTopics(): Promise<PlatformTopic[]> {
    return db.select().from(platformTopics);
  }

  async createPlatformTopic(data: InsertPlatformTopic): Promise<PlatformTopic> {
    const rows = await db.insert(platformTopics).values(data).returning();
    return rows[0];
  }

  async getTopicsWithStats(): Promise<(PlatformTopic & { feedbackCount: number; posCount: number; neutCount: number; negCount: number })[]> {
    const allTopics = await db.select().from(platformTopics);
    return Promise.all(allTopics.map(async t => {
      const rows = await db.select().from(meetingTopics).where(eq(meetingTopics.topicId, t.id));
      return {
        ...t,
        feedbackCount: rows.length,
        posCount: rows.filter(r => r.sentiment === "positive").length,
        neutCount: rows.filter(r => r.sentiment === "neutral").length,
        negCount: rows.filter(r => r.sentiment === "negative").length,
      };
    }));
  }

  // ── MeetingTopics ──────────────────────────────────────────────────────────

  async getMeetingTopics(meetingId: number): Promise<(MeetingTopic & { topic: PlatformTopic })[]> {
    const rows = await db.select().from(meetingTopics).where(eq(meetingTopics.meetingId, meetingId));
    const result: (MeetingTopic & { topic: PlatformTopic })[] = [];
    for (const mt of rows) {
      const t = (await db.select().from(platformTopics).where(eq(platformTopics.id, mt.topicId)))[0];
      if (t) result.push({ ...mt, topic: t });
    }
    return result;
  }

  async addMeetingTopic(data: InsertMeetingTopic): Promise<MeetingTopic> {
    const rows = await db.insert(meetingTopics).values(data).returning();
    return rows[0];
  }

  async removeMeetingTopic(id: number): Promise<void> {
    await db.delete(meetingTopics).where(eq(meetingTopics.id, id));
  }

  async getMeetingTopicEntries(topicId: number): Promise<import("./storage").TopicEntry[]> {
    const mtRows = await db.select().from(meetingTopics).where(eq(meetingTopics.topicId, topicId));
    const result: import("./storage").TopicEntry[] = [];
    for (const mt of mtRows) {
      const mtg = (await db.select().from(meetings).where(eq(meetings.id, mt.meetingId)))[0];
      if (!mtg) continue;
      const company = (await db.select().from(companies).where(eq(companies.id, mtg.companyId)))[0];
      const ev = (await db.select().from(events).where(eq(events.id, mtg.eventId)))[0];
      if (!ev) continue;
      result.push({
        meetingTopicId: mt.id,
        sentiment: mt.sentiment ?? null,
        feedbackSummary: mt.feedbackSummary ?? null,
        requestOrBlocker: mt.requestOrBlocker ?? null,
        priority: mt.priority ?? null,
        meetingId: mtg.id,
        meetingDate: mtg.meetingDate ?? null,
        meetingLocation: mtg.location ?? null,
        companyName: company?.name ?? "Unknown",
        eventId: ev.id,
        eventName: ev.name,
      });
    }
    return result;
  }

  // ── EventExecutiveSummaries ────────────────────────────────────────────────

  async getExecSummaryByEvent(eventId: number): Promise<EventExecutiveSummary | undefined> {
    const rows = await db.select().from(eventExecutiveSummaries).where(eq(eventExecutiveSummaries.eventId, eventId));
    return rows[0];
  }

  async upsertExecSummary(data: InsertEventExecutiveSummary): Promise<EventExecutiveSummary> {
    const rows = await db
      .insert(eventExecutiveSummaries)
      .values(data)
      .onConflictDoUpdate({
        target: eventExecutiveSummaries.eventId,
        set: {
          ...data,
          lastRefreshedAt: new Date(),
        },
      })
      .returning();
    return rows[0];
  }

  // ── GlobalSummaries ────────────────────────────────────────────────────────

  async getLatestGlobalSummary(): Promise<GlobalSummary | undefined> {
    const rows = await db.select().from(globalSummaries).orderBy(desc(globalSummaries.generatedAt)).limit(1);
    return rows[0];
  }

  async createGlobalSummary(data: InsertGlobalSummary): Promise<GlobalSummary> {
    const rows = await db.insert(globalSummaries).values(data).returning();
    return rows[0];
  }

  // ── SourceDocuments ────────────────────────────────────────────────────────

  async getSourceDocumentsByEvent(eventId: number): Promise<SourceDocument[]> {
    return db.select().from(sourceDocuments).where(eq(sourceDocuments.eventId, eventId));
  }

  async getSourceDocumentById(id: number): Promise<SourceDocument | undefined> {
    const rows = await db.select().from(sourceDocuments).where(eq(sourceDocuments.id, id));
    return rows[0];
  }

  async createSourceDocument(data: InsertSourceDocument): Promise<SourceDocument> {
    const rows = await db.insert(sourceDocuments).values(data).returning();
    return rows[0];
  }

  async updateSourceDocument(id: number, data: Partial<InsertSourceDocument>): Promise<SourceDocument> {
    const rows = await db.update(sourceDocuments).set(data).where(eq(sourceDocuments.id, id)).returning();
    if (!rows[0]) throw new Error(`SourceDocument ${id} not found`);
    return rows[0];
  }

  // ── ParsedSections ─────────────────────────────────────────────────────────

  async deleteSourceDocument(id: number): Promise<void> {
    await db.delete(sourceDocuments).where(eq(sourceDocuments.id, id));
  }

  async getParsedSectionsByDocument(sourceDocumentId: number): Promise<ParsedSection[]> {
    return db.select().from(parsedSections).where(eq(parsedSections.sourceDocumentId, sourceDocumentId));
  }

  async createParsedSection(data: InsertParsedSection): Promise<ParsedSection> {
    const rows = await db.insert(parsedSections).values(data).returning();
    return rows[0];
  }
}
