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

// ── Drill-down entry types ──────────────────────────────────────────────────
export interface TopicEntry {
  meetingTopicId: number;
  sentiment: string | null;
  feedbackSummary: string | null;
  requestOrBlocker: string | null;
  priority: string | null;
  meetingId: number;
  meetingDate: string | null;
  meetingLocation: string | null;
  companyName: string;
  eventId: number;
  eventName: string;
}

export interface GameEntry {
  meetingGameId: number;
  gameSpecificSentiment: string | null;
  discussionSummary: string | null;
  dealStatus: string | null;
  projectedLaunchTiming: string | null;
  keyQuotes: string | null;
  meetingId: number;
  meetingDate: string | null;
  meetingLocation: string | null;
  companyName: string;
  eventId: number;
  eventName: string;
}
// ───────────────────────────────────────────────────────────────────────────

export interface IStorage {
  // Users
  getUsers(): Promise<User[]>;
  getUserById(id: number): Promise<User | undefined>;
  createUser(data: InsertUser): Promise<User>;

  // Events
  getEvents(): Promise<EventWithStats[]>;
  getEventById(id: number): Promise<Event | undefined>;
  getEventWithStats(id: number): Promise<EventWithStats | undefined>;
  createEvent(data: InsertEvent): Promise<Event>;
  updateEvent(id: number, data: Partial<InsertEvent>): Promise<Event>;
  deleteEvent(id: number): Promise<void>;

  // EventAttendees
  getEventAttendees(eventId: number): Promise<(EventAttendee & { user: User })[]>;
  addEventAttendee(data: InsertEventAttendee): Promise<EventAttendee>;

  // Companies
  getCompanies(): Promise<Company[]>;
  getCompanyById(id: number): Promise<Company | undefined>;
  createCompany(data: InsertCompany): Promise<Company>;
  updateCompany(id: number, data: Partial<InsertCompany>): Promise<Company>;

  // Contacts
  getContactsByCompany(companyId: number): Promise<Contact[]>;
  createContact(data: InsertContact): Promise<Contact>;

  // Meetings
  getMeetingsByEvent(eventId: number): Promise<MeetingWithDetails[]>;
  getMeetingById(id: number): Promise<MeetingWithDetails | undefined>;
  createMeeting(data: InsertMeeting): Promise<Meeting>;
  updateMeeting(id: number, data: Partial<InsertMeeting>): Promise<Meeting>;
  deleteMeeting(id: number): Promise<void>;

  // MeetingContacts
  addMeetingContact(data: InsertMeetingContact): Promise<MeetingContact>;

  // Games
  getGames(): Promise<Game[]>;
  getGameById(id: number): Promise<Game | undefined>;
  createGame(data: InsertGame): Promise<Game>;
  updateGame(id: number, data: Partial<InsertGame>): Promise<Game>;
  getGamesWithTouchpoints(): Promise<(Game & { touchpointCount: number; sentiments: string[]; events: string[] })[]>;

  // MeetingGames
  getMeetingGames(meetingId: number): Promise<(MeetingGame & { game: Game })[]>;
  getMeetingGameEntries(gameId: number): Promise<GameEntry[]>;
  addMeetingGame(data: InsertMeetingGame): Promise<MeetingGame>;
  removeMeetingGame(id: number): Promise<void>;

  // PlatformTopics
  getPlatformTopics(): Promise<PlatformTopic[]>;
  createPlatformTopic(data: InsertPlatformTopic): Promise<PlatformTopic>;
  getTopicsWithStats(): Promise<(PlatformTopic & { feedbackCount: number; posCount: number; neutCount: number; negCount: number })[]>;

  // MeetingTopics
  getMeetingTopics(meetingId: number): Promise<(MeetingTopic & { topic: PlatformTopic })[]>;
  getMeetingTopicEntries(topicId: number): Promise<TopicEntry[]>;
  addMeetingTopic(data: InsertMeetingTopic): Promise<MeetingTopic>;
  removeMeetingTopic(id: number): Promise<void>;

  // EventExecutiveSummaries
  getExecSummaryByEvent(eventId: number): Promise<EventExecutiveSummary | undefined>;
  upsertExecSummary(data: InsertEventExecutiveSummary): Promise<EventExecutiveSummary>;

  // GlobalSummaries
  getLatestGlobalSummary(): Promise<GlobalSummary | undefined>;
  createGlobalSummary(data: InsertGlobalSummary): Promise<GlobalSummary>;

  // SourceDocuments
  getSourceDocumentsByEvent(eventId: number): Promise<SourceDocument[]>;
  getSourceDocumentById(id: number): Promise<SourceDocument | undefined>;
  createSourceDocument(data: InsertSourceDocument): Promise<SourceDocument>;
  updateSourceDocument(id: number, data: Partial<InsertSourceDocument>): Promise<SourceDocument>;
  deleteSourceDocument(id: number): Promise<void>;

  // ParsedSections
  getParsedSectionsByDocument(sourceDocumentId: number): Promise<ParsedSection[]>;
  createParsedSection(data: InsertParsedSection): Promise<ParsedSection>;
}

// ─── In-Memory Storage ────────────────────────────────────────────────────────

export class MemStorage implements IStorage {
  private users: Map<number, User> = new Map();
  private events: Map<number, Event> = new Map();
  private eventAttendees: Map<number, EventAttendee> = new Map();
  private companies: Map<number, Company> = new Map();
  private contacts: Map<number, Contact> = new Map();
  private meetings: Map<number, Meeting> = new Map();
  private meetingContacts: Map<number, MeetingContact> = new Map();
  private games: Map<number, Game> = new Map();
  private meetingGames: Map<number, MeetingGame> = new Map();
  private platformTopics: Map<number, PlatformTopic> = new Map();
  private meetingTopics: Map<number, MeetingTopic> = new Map();
  private execSummaries: Map<number, EventExecutiveSummary> = new Map(); // keyed by eventId
  private globalSummaries: Map<number, GlobalSummary> = new Map();
  private sourceDocuments: Map<number, SourceDocument> = new Map();
  private parsedSections: Map<number, ParsedSection> = new Map();

  private nextId = 1;
  private getId() { return this.nextId++; }

  constructor() {
    this.seed();
  }

  private seed() {
    // Seed users
    const u1: User = { id: this.getId(), name: "Alex Chen", email: "alex.chen@epicgames.com", role: "bd", team: "Publisher BD - APAC", createdAt: new Date(), updatedAt: new Date() };
    const u2: User = { id: this.getId(), name: "Jordan Rivera", email: "jordan.rivera@epicgames.com", role: "am", team: "Account Management - EMEA", createdAt: new Date(), updatedAt: new Date() };
    const u3: User = { id: this.getId(), name: "Sam Park", email: "sam.park@epicgames.com", role: "bd", team: "Publisher BD - NA", createdAt: new Date(), updatedAt: new Date() };
    [u1, u2, u3].forEach(u => this.users.set(u.id, u));

    // Seed companies
    const c1: Company = { id: this.getId(), name: "Nexon Games", companyType: "developer", region: "APAC", notes: null, createdAt: new Date(), updatedAt: new Date() };
    const c2: Company = { id: this.getId(), name: "505 Games", companyType: "publisher", region: "EMEA", notes: null, createdAt: new Date(), updatedAt: new Date() };
    const c3: Company = { id: this.getId(), name: "Devolver Digital", companyType: "publisher", region: "NA", notes: "Indie publisher, anti-AAA positioning", createdAt: new Date(), updatedAt: new Date() };
    const c4: Company = { id: this.getId(), name: "Thunderful Group", companyType: "mixed", region: "EMEA", notes: null, createdAt: new Date(), updatedAt: new Date() };
    [c1, c2, c3, c4].forEach(c => this.companies.set(c.id, c));

    // Seed contacts
    const ct1: Contact = { id: this.getId(), companyId: c1.id, name: "Yuki Tanaka", title: "Head of PC Publishing", email: "y.tanaka@nexon.com", phone: null, notes: null, createdAt: new Date() };
    const ct2: Contact = { id: this.getId(), companyId: c2.id, name: "Marco Bianchi", title: "VP Partnerships", email: "m.bianchi@505games.com", phone: null, notes: "Key decision maker", createdAt: new Date() };
    const ct3: Contact = { id: this.getId(), companyId: c3.id, name: "Graeme Struthers", title: "Co-Founder", email: null, phone: null, notes: "Skeptical of exclusivity deals", createdAt: new Date() };
    const ct4: Contact = { id: this.getId(), companyId: c4.id, name: "Bo Andersson", title: "CEO", email: "b.andersson@thunderful.se", phone: null, notes: null, createdAt: new Date() };
    [ct1, ct2, ct3, ct4].forEach(ct => this.contacts.set(ct.id, ct));

    // Seed platform topics
    const pt1: PlatformTopic = { id: this.getId(), name: "Revenue Share / Commercial Terms", category: "commercial", description: "88/12 split discussion, MFN clauses, launch bonuses", createdAt: new Date(), updatedAt: new Date() };
    const pt2: PlatformTopic = { id: this.getId(), name: "Discovery & Featuring", category: "product", description: "Store front visibility, editorial featuring, search ranking", createdAt: new Date(), updatedAt: new Date() };
    const pt3: PlatformTopic = { id: this.getId(), name: "Tools & SDK", category: "tech", description: "EOS integration complexity, overlay features, achievement system", createdAt: new Date(), updatedAt: new Date() };
    const pt4: PlatformTopic = { id: this.getId(), name: "Payments & Reporting", category: "operations", description: "Analytics dashboard, payment timelines, currency support", createdAt: new Date(), updatedAt: new Date() };
    const pt5: PlatformTopic = { id: this.getId(), name: "User Acquisition & Marketing", category: "marketing", description: "Free games program, launch marketing support, UA budget", createdAt: new Date(), updatedAt: new Date() };
    [pt1, pt2, pt3, pt4, pt5].forEach(pt => this.platformTopics.set(pt.id, pt));

    // Seed games
    const g1: Game = { id: this.getId(), title: "Vindictus: Defying Fate", developerCompanyId: c1.id, publisherCompanyId: c1.id, currentEgsStatus: "announced", notes: "Action RPG. Announced for EGS 2026.", createdAt: new Date(), updatedAt: new Date() };
    const g2: Game = { id: this.getId(), title: "Ghostrunner 3", developerCompanyId: c2.id, publisherCompanyId: c2.id, currentEgsStatus: "under_discussion", notes: "505 asking for 90-day exclusivity window pricing.", createdAt: new Date(), updatedAt: new Date() };
    const g3: Game = { id: this.getId(), title: "Skald: Against the Black Priory 2", developerCompanyId: c4.id, publisherCompanyId: c4.id, currentEgsStatus: "not_coming", notes: "Thunderful confirmed Steam-only for now.", createdAt: new Date(), updatedAt: new Date() };
    const g4: Game = { id: this.getId(), title: "Metal: Hellsinger 2", developerCompanyId: c4.id, publisherCompanyId: c4.id, currentEgsStatus: "unknown", notes: "Early discussions, no commitment.", createdAt: new Date(), updatedAt: new Date() };
    const g5: Game = { id: this.getId(), title: "Devolver Arcade Collection", developerCompanyId: c3.id, publisherCompanyId: c3.id, currentEgsStatus: "not_coming", notes: "Devolver explicitly said no EGS launches planned.", createdAt: new Date(), updatedAt: new Date() };
    [g1, g2, g3, g4, g5].forEach(g => this.games.set(g.id, g));

    // Seed events
    const e1: Event = { id: this.getId(), name: "GDC 2026", description: "Game Developers Conference, Moscone Center", eventType: "conference", startDate: "2026-03-17", endDate: "2026-03-21", city: "San Francisco", country: "USA", primaryOwnerUserId: u1.id, isDummy: false, createdAt: new Date(), updatedAt: new Date() };
    const e2: Event = { id: this.getId(), name: "Gamescom 2025", description: "World's largest gaming expo", eventType: "conference", startDate: "2025-08-20", endDate: "2025-08-24", city: "Cologne", country: "Germany", primaryOwnerUserId: u2.id, isDummy: false, createdAt: new Date(), updatedAt: new Date() };
    const e3: Event = { id: this.getId(), name: "Tokyo Publisher Roadshow Q1 2026", description: "BD roadshow targeting APAC publishers", eventType: "roadshow", startDate: "2026-01-15", endDate: "2026-01-18", city: "Tokyo", country: "Japan", primaryOwnerUserId: u1.id, isDummy: false, createdAt: new Date(), updatedAt: new Date() };

    // ── Dummy example events ──────────────────────────────────────────────────
    const dummyE1: Event = { id: this.getId(), name: "[EXAMPLE] E3 2025 Partner Meetings", description: "Example event — E3 partner meetings at the LA Convention Center", eventType: "conference", startDate: "2025-06-10", endDate: "2025-06-13", city: "Los Angeles", country: "USA", primaryOwnerUserId: u3.id, isDummy: true, createdAt: new Date(), updatedAt: new Date() };
    const dummyE2: Event = { id: this.getId(), name: "[EXAMPLE] Nordic Game 2025 Trip", description: "Example event — Nordic Game conference trip report", eventType: "conference", startDate: "2025-05-20", endDate: "2025-05-22", city: "Malmö", country: "Sweden", primaryOwnerUserId: u2.id, isDummy: true, createdAt: new Date(), updatedAt: new Date() };

    [e1, e2, e3, dummyE1, dummyE2].forEach(e => this.events.set(e.id, e));

    // Seed event attendees
    this.eventAttendees.set(this.getId(), { id: this.nextId - 1, eventId: e1.id, userId: u1.id, roleAtEvent: "Lead BD" });
    this.eventAttendees.set(this.getId(), { id: this.nextId - 1, eventId: e1.id, userId: u3.id, roleAtEvent: "BD Support" });
    this.eventAttendees.set(this.getId(), { id: this.nextId - 1, eventId: e2.id, userId: u2.id, roleAtEvent: "Lead AM" });
    this.eventAttendees.set(this.getId(), { id: this.nextId - 1, eventId: e3.id, userId: u1.id, roleAtEvent: "Lead BD" });

    // Seed meetings
    const m1: Meeting = { id: this.getId(), eventId: e1.id, companyId: c1.id, meetingDate: "2026-03-18", startTime: "10:00", endTime: "10:45", location: "Room 3006, Moscone North", format: "in_person", overallSentiment: "positive", summary: "Nexon confirmed Vindictus: Defying Fate for EGS. Excited about 88/12 split and launch bonus structure. Timeline aligned for Q4 2026.", detailedNotes: "Yuki opened with strong interest in EGS DAU growth. We discussed the launch bonus structure for titles in 2026. She confirmed Vindictus: Defying Fate will come to EGS. Revenue share was praised. Main ask: better analytics dashboard before launch. Follow-up call scheduled for April.", followUpActions: "Share updated analytics roadmap. Schedule April call.", followUpOwnerUserId: u1.id, followUpDueDate: "2026-04-01", createdAt: new Date(), updatedAt: new Date() };
    const m2: Meeting = { id: this.getId(), eventId: e1.id, companyId: c2.id, meetingDate: "2026-03-18", startTime: "14:00", endTime: "15:00", location: "Room 2016, Moscone West", format: "in_person", overallSentiment: "neutral", summary: "505 Games is interested in Ghostrunner 3 on EGS but wants MFN clause clarification and a minimum guarantee discussion. No commitment yet.", detailedNotes: "Marco led the discussion. They are currently in talks with Steam about a Ghostrunner 3 date. They have questions about MFN clause applicability for DLC. They want a written summary of the exclusivity window options. Not ready to commit but engaged. Requested a follow-up with legal on MFN.", followUpActions: "Send MFN clause summary. Loop in Legal team.", followUpOwnerUserId: u3.id, followUpDueDate: "2026-03-28", createdAt: new Date(), updatedAt: new Date() };
    const m3: Meeting = { id: this.getId(), eventId: e1.id, companyId: c3.id, meetingDate: "2026-03-19", startTime: "11:00", endTime: "11:30", location: "Devolver Suite, Marriott Marquis", format: "in_person", overallSentiment: "negative", summary: "Devolver Digital will not be bringing any games to EGS this year. Graeme cited user acquisition concerns and integration overhead as blockers.", detailedNotes: "Graeme was direct: Devolver has no plans to ship on EGS in 2026. He cited low EGS UA relative to Steam for their titles. The EOS SDK integration was described as 'annoying overhead'. He is open to revisiting in 2027 if UA metrics improve. No ask for follow-up.", followUpActions: "Monitor Devolver game launches on Steam. Re-approach in late 2026.", followUpOwnerUserId: u3.id, followUpDueDate: "2026-11-01", createdAt: new Date(), updatedAt: new Date() };
    const m4: Meeting = { id: this.getId(), eventId: e2.id, companyId: c4.id, meetingDate: "2025-08-21", startTime: "09:30", endTime: "10:15", location: "Business Area Hall 4.2, Messe Köln", format: "in_person", overallSentiment: "negative", summary: "Thunderful Group confirmed Skald 2 is Steam-only. Metal: Hellsinger 2 is undecided. Concerns about EGS tooling and lower sales projections.", detailedNotes: "Bo was candid that EGS sales for their prior titles were significantly below Steam. Skald 2 has been confirmed Steam-only. They are open to Metal: Hellsinger 2 on EGS if we can provide a minimum guaranteed sales number or marketing spend. Tools concern: they want a better achievement/trophy implementation before committing.", followUpActions: "Internal: explore Min Guarantee structure for Thunderful. Share EOS achievement roadmap.", followUpOwnerUserId: u2.id, followUpDueDate: "2025-09-15", createdAt: new Date(), updatedAt: new Date() };
    const m5: Meeting = { id: this.getId(), eventId: e3.id, companyId: c1.id, meetingDate: "2026-01-16", startTime: "13:00", endTime: "14:00", location: "Andaz Tokyo, Meeting Room B", format: "in_person", overallSentiment: "positive", summary: "Strong follow-up from GDC conversation. Nexon confirmed additional 3 titles for EGS evaluation in 2026-2027 pipeline. Contract terms agreed in principle.", detailedNotes: "Yuki brought her PC lead and a BD coordinator. They confirmed they are evaluating 3 additional titles beyond Vindictus for EGS. Commercial terms agreed in principle — formal term sheet to follow. Analytics dashboard was raised again as a must-have. Sentiment very positive overall.", followUpActions: "Send term sheet draft. Confirm analytics timeline with product.", followUpOwnerUserId: u1.id, followUpDueDate: "2026-01-30", createdAt: new Date(), updatedAt: new Date() };
    [m1, m2, m3, m4, m5].forEach(m => this.meetings.set(m.id, m));

    // Seed meeting contacts
    [
      { meetingId: m1.id, contactId: ct1.id, roleInMeeting: "Lead" },
      { meetingId: m2.id, contactId: ct2.id, roleInMeeting: "Lead" },
      { meetingId: m3.id, contactId: ct3.id, roleInMeeting: "Lead" },
      { meetingId: m4.id, contactId: ct4.id, roleInMeeting: "Lead" },
      { meetingId: m5.id, contactId: ct1.id, roleInMeeting: "Lead" },
    ].forEach(mc => {
      const id = this.getId();
      this.meetingContacts.set(id, { id, ...mc });
    });

    // Seed meeting games
    [
      { meetingId: m1.id, gameId: g1.id, gameSpecificSentiment: "positive" as const, discussionSummary: "Confirmed for EGS Q4 2026. Launch bonus accepted.", dealStatus: "signed" as const, projectedLaunchTiming: "Q4 2026", keyQuotes: "\"We are very excited about Epic's platform direction\" — Yuki Tanaka" },
      { meetingId: m2.id, gameId: g2.id, gameSpecificSentiment: "neutral" as const, discussionSummary: "MFN clause under review. No timeline set.", dealStatus: "in_negotiation" as const, projectedLaunchTiming: null, keyQuotes: null },
      { meetingId: m3.id, gameId: g5.id, gameSpecificSentiment: "negative" as const, discussionSummary: "No EGS release planned. SDK overhead cited.", dealStatus: "lost" as const, projectedLaunchTiming: null, keyQuotes: "\"EGS UA is just not there for our catalog\" — Graeme Struthers" },
      { meetingId: m4.id, gameId: g3.id, gameSpecificSentiment: "negative" as const, discussionSummary: "Confirmed Steam-only.", dealStatus: "lost" as const, projectedLaunchTiming: null, keyQuotes: null },
      { meetingId: m4.id, gameId: g4.id, gameSpecificSentiment: "neutral" as const, discussionSummary: "Under consideration pending minimum guarantee.", dealStatus: "initial_outreach" as const, projectedLaunchTiming: "TBD 2026", keyQuotes: null },
      { meetingId: m5.id, gameId: g1.id, gameSpecificSentiment: "positive" as const, discussionSummary: "Terms agreed in principle. Term sheet pending.", dealStatus: "in_negotiation" as const, projectedLaunchTiming: "Q4 2026", keyQuotes: null },
    ].forEach(mg => {
      const id = this.getId();
      this.meetingGames.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...mg });
    });

    // Seed meeting topics
    [
      { meetingId: m1.id, topicId: pt1.id, sentiment: "positive" as const, feedbackSummary: "88/12 praised. Launch bonus structure well received.", requestOrBlocker: null, priority: "high" as const },
      { meetingId: m1.id, topicId: pt4.id, sentiment: "neutral" as const, feedbackSummary: "Analytics dashboard needs improvement before launch.", requestOrBlocker: "Better analytics dashboard required", priority: "high" as const },
      { meetingId: m2.id, topicId: pt1.id, sentiment: "neutral" as const, feedbackSummary: "MFN clause applicability for DLC is unclear.", requestOrBlocker: "Written MFN summary needed", priority: "medium" as const },
      { meetingId: m3.id, topicId: pt3.id, sentiment: "negative" as const, feedbackSummary: "EOS SDK described as annoying overhead by Devolver.", requestOrBlocker: "SDK integration complexity", priority: "high" as const },
      { meetingId: m3.id, topicId: pt5.id, sentiment: "negative" as const, feedbackSummary: "EGS UA metrics are too low compared to Steam for Devolver catalog.", requestOrBlocker: "Insufficient EGS UA", priority: "high" as const },
      { meetingId: m4.id, topicId: pt3.id, sentiment: "negative" as const, feedbackSummary: "Achievement/trophy implementation needs work.", requestOrBlocker: "Achievement system improvement", priority: "medium" as const },
      { meetingId: m4.id, topicId: pt2.id, sentiment: "neutral" as const, feedbackSummary: "Thunderful uncertain about EGS discoverability vs Steam.", requestOrBlocker: null, priority: "medium" as const },
      { meetingId: m5.id, topicId: pt1.id, sentiment: "positive" as const, feedbackSummary: "Commercial terms agreed in principle.", requestOrBlocker: null, priority: "high" as const },
    ].forEach(mt => {
      const id = this.getId();
      this.meetingTopics.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...mt });
    });

    // Seed executive summaries
    const es1: EventExecutiveSummary = {
      id: this.getId(),
      eventId: e1.id,
      macroThemes: "Strong positive signal from APAC publishers (Nexon) vs. resistance from established indie publishers (Devolver). SDK/tooling and UA concerns are consistent blockers among mid-tier developers.",
      highlights: "Nexon confirmed Vindictus: Defying Fate for EGS Q4 2026. Commercial terms accepted. 505 Games engaged on Ghostrunner 3 — MFN discussion ongoing. High-value opportunity with strong momentum.",
      negatives: "Devolver Digital explicitly stated no EGS games in 2026, citing low UA and EOS SDK overhead. This is a significant negative signal from a high-profile indie publisher. Their sentiment may reflect a broader indie publisher concern.",
      recommendations: "1. Prioritize EOS SDK simplification — multiple negative mentions across meetings. 2. Develop a stronger UA case study / deck for indie publishers like Devolver. 3. Fast-track analytics dashboard improvements per Nexon's requirement. 4. Explore min-guarantee structure with 505 to close Ghostrunner 3.",
      topOpportunities: ["Vindictus: Defying Fate (Nexon) — Q4 2026 launch on track", "Ghostrunner 3 (505 Games) — active negotiation", "Nexon 3-title pipeline evaluation for 2026-2027"],
      topRisks: ["Devolver Digital lost — SDK and UA concerns signal broader indie resistance", "505 MFN clause unresolved — deal could fall through without legal clarity", "Tooling gap (analytics, achievements) cited by 2 out of 3 publishers"],
      topActions: [
        { action: "Share analytics roadmap with Nexon", owner: "Alex Chen", dueDate: "2026-04-01" },
        { action: "Send MFN clause summary to 505 Games", owner: "Sam Park", dueDate: "2026-03-28" },
        { action: "Internal review: min guarantee structure for 505 & Thunderful", owner: "Alex Chen", dueDate: "2026-04-05" },
      ],
      citationMap: null,
      generatedAt: new Date(),
      lastRefreshedAt: new Date(),
    };
    this.execSummaries.set(e1.id, es1);

    const es2: EventExecutiveSummary = {
      id: this.getId(),
      eventId: e2.id,
      macroThemes: "EMEA publishers showing increased skepticism about EGS platform tooling and sales projections. Min-guarantee deal structure emerging as a potential unlocking mechanism.",
      highlights: "Productive meeting with Thunderful — Metal: Hellsinger 2 remains a possibility if commercial terms improve. Relationship maintained for follow-up.",
      negatives: "Thunderful confirmed Skald 2 is Steam-only. Cited significantly lower EGS sales vs. Steam for their back catalog. Achievement system cited as an issue.",
      recommendations: "1. Develop a formal min-guarantee proposal for Thunderful for Metal: Hellsinger 2. 2. Share EOS achievement roadmap immediately. 3. Conduct a portfolio analysis of EGS vs Steam performance for similar Thunderful titles to validate or counter their projection.",
      topOpportunities: ["Metal: Hellsinger 2 (Thunderful) — reachable with improved terms"],
      topRisks: ["Skald 2 confirmed lost", "Achievement system gap continues to hurt deals"],
      topActions: [
        { action: "Explore min-guarantee deal for Thunderful Metal: Hellsinger 2", owner: "Jordan Rivera", dueDate: "2025-09-15" },
        { action: "Share EOS achievement system roadmap with Thunderful", owner: "Jordan Rivera", dueDate: "2025-09-10" },
      ],
      citationMap: null,
      generatedAt: new Date(),
      lastRefreshedAt: new Date(),
    };
    this.execSummaries.set(e2.id, es2);

    // Seed source documents
    const sd1: SourceDocument = { id: this.getId(), eventId: e1.id, sourceType: "pasted_text", originalFileName: null, externalUrl: null, storagePathOrId: "blob://gdc-2026-raw", uploadedByUserId: u1.id, uploadedAt: new Date(), parsingStatus: "success", parsingLog: "Extracted 3 meeting blocks, 2 game mentions, 4 platform topic references.", rawTextExcerpt: "GDC 2026 Trip Report — Alex Chen...\n\n### Meeting: Nexon Games (Yuki Tanaka)\nDate: March 18, 10:00 AM\nSentiment: Very positive...", rawText: null };
    const sd2: SourceDocument = { id: this.getId(), eventId: e2.id, sourceType: "google_doc", originalFileName: null, externalUrl: "https://docs.google.com/document/d/example-gamescom-2025", storagePathOrId: null, uploadedByUserId: u2.id, uploadedAt: new Date(), parsingStatus: "success", parsingLog: "Extracted 1 meeting block, 2 game mentions.", rawTextExcerpt: "Gamescom 2025 Notes — Jordan Rivera...", rawText: null };
    [sd1, sd2].forEach(sd => this.sourceDocuments.set(sd.id, sd));

    // ── Dummy example event data ─────────────────────────────────────────────
    // Dummy event 1 attendees
    this.eventAttendees.set(this.getId(), { id: this.nextId - 1, eventId: dummyE1.id, userId: u3.id, roleAtEvent: "Lead BD" });
    this.eventAttendees.set(this.getId(), { id: this.nextId - 1, eventId: dummyE2.id, userId: u2.id, roleAtEvent: "Lead AM" });

    // Dummy companies for examples
    const dc1: Company = { id: this.getId(), name: "Acme Interactive", companyType: "developer", region: "NA", notes: "Example company — fictional", createdAt: new Date(), updatedAt: new Date() };
    const dc2: Company = { id: this.getId(), name: "Fjord Studios", companyType: "publisher", region: "EMEA", notes: "Example company — fictional", createdAt: new Date(), updatedAt: new Date() };
    [dc1, dc2].forEach(c => this.companies.set(c.id, c));

    // Dummy contacts
    const dct1: Contact = { id: this.getId(), companyId: dc1.id, name: "Jane Doe", title: "VP Publishing", email: null, phone: null, notes: "Fictional contact", createdAt: new Date() };
    const dct2: Contact = { id: this.getId(), companyId: dc2.id, name: "Erik Lindgren", title: "Head of BD", email: null, phone: null, notes: "Fictional contact", createdAt: new Date() };
    [dct1, dct2].forEach(ct => this.contacts.set(ct.id, ct));

    // Dummy games
    const dg1: Game = { id: this.getId(), title: "Starfall Chronicles", developerCompanyId: dc1.id, publisherCompanyId: dc1.id, currentEgsStatus: "under_discussion", notes: "Example game — fictional", createdAt: new Date(), updatedAt: new Date() };
    const dg2: Game = { id: this.getId(), title: "Frozen Tides", developerCompanyId: dc2.id, publisherCompanyId: dc2.id, currentEgsStatus: "announced", notes: "Example game — fictional", createdAt: new Date(), updatedAt: new Date() };
    [dg1, dg2].forEach(g => this.games.set(g.id, g));

    // Dummy meetings — E3
    const dm1: Meeting = { id: this.getId(), eventId: dummyE1.id, companyId: dc1.id, meetingDate: "2025-06-11", startTime: "10:00", endTime: "10:45", location: "Meeting Room 4A, West Hall", format: "in_person", overallSentiment: "positive", summary: "Acme Interactive excited about bringing Starfall Chronicles to EGS. Revenue share terms praised. Requesting marketing co-promotion support for launch.", detailedNotes: "Jane Doe led the discussion. Acme has been evaluating EGS for 6 months. Very impressed with the 88/12 revenue split. They want to launch Starfall Chronicles on EGS simultaneously with Steam. Main ask: co-marketing support and featuring placement. Timeline: Q1 2026.", followUpActions: "Send marketing co-op proposal. Schedule follow-up call for July.", followUpOwnerUserId: u3.id, followUpDueDate: "2025-07-01", createdAt: new Date(), updatedAt: new Date() };
    const dm2: Meeting = { id: this.getId(), eventId: dummyE1.id, companyId: dc2.id, meetingDate: "2025-06-12", startTime: "14:00", endTime: "14:30", location: "Lobby Lounge, JW Marriott", format: "in_person", overallSentiment: "neutral", summary: "Fjord Studios evaluating EGS for Frozen Tides but concerned about discoverability compared to Steam. Want to see more data on conversion rates.", detailedNotes: "Erik was direct about their hesitation — Fjord's previous titles underperformed on EGS relative to Steam. They want hard numbers on conversion rates and wishlists before committing Frozen Tides. Open to a data-sharing session. Not hostile, just cautious.", followUpActions: "Prepare EGS conversion rate deck. Share wishlist performance data.", followUpOwnerUserId: u3.id, followUpDueDate: "2025-07-15", createdAt: new Date(), updatedAt: new Date() };

    // Dummy meetings — Nordic Game
    const dm3: Meeting = { id: this.getId(), eventId: dummyE2.id, companyId: dc2.id, meetingDate: "2025-05-21", startTime: "11:00", endTime: "11:45", location: "Scandic Hotel Conference Center", format: "in_person", overallSentiment: "positive", summary: "Follow-up with Fjord Studios from earlier conversations. They are now leaning positive on bringing Frozen Tides to EGS if launch window exclusivity terms are favorable.", detailedNotes: "Erik brought his CEO this time, signaling higher-level interest. They are now more open to EGS after seeing Q1 2025 growth data we shared. Main discussion around launch window exclusivity — they want a 30-day window max, not 90. We discussed a compromise at 60 days with enhanced featuring. CEO seemed receptive.", followUpActions: "Draft 60-day exclusivity proposal. Share with Fjord legal team.", followUpOwnerUserId: u2.id, followUpDueDate: "2025-06-05", createdAt: new Date(), updatedAt: new Date() };

    [dm1, dm2, dm3].forEach(m => this.meetings.set(m.id, m));

    // Dummy meeting contacts
    [{ meetingId: dm1.id, contactId: dct1.id, roleInMeeting: "Lead" },
     { meetingId: dm2.id, contactId: dct2.id, roleInMeeting: "Lead" },
     { meetingId: dm3.id, contactId: dct2.id, roleInMeeting: "Lead" },
    ].forEach(mc => {
      const id = this.getId();
      this.meetingContacts.set(id, { id, ...mc });
    });

    // Dummy meeting games
    [{ meetingId: dm1.id, gameId: dg1.id, gameSpecificSentiment: "positive" as const, discussionSummary: "Starfall Chronicles confirmed interested in EGS launch.", dealStatus: "in_negotiation" as const, projectedLaunchTiming: "Q1 2026", keyQuotes: "\"The 88/12 split is exactly what indie devs need\" — Jane Doe" },
     { meetingId: dm2.id, gameId: dg2.id, gameSpecificSentiment: "neutral" as const, discussionSummary: "Frozen Tides still evaluating. Data request pending.", dealStatus: "initial_outreach" as const, projectedLaunchTiming: null, keyQuotes: null },
     { meetingId: dm3.id, gameId: dg2.id, gameSpecificSentiment: "positive" as const, discussionSummary: "Frozen Tides moving toward EGS. 60-day exclusivity discussed.", dealStatus: "in_negotiation" as const, projectedLaunchTiming: "Q3 2025", keyQuotes: "\"We're much more optimistic after seeing the Q1 numbers\" — Erik Lindgren" },
    ].forEach(mg => {
      const id = this.getId();
      this.meetingGames.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...mg });
    });

    // Dummy meeting topics
    [{ meetingId: dm1.id, topicId: pt1.id, sentiment: "positive" as const, feedbackSummary: "88/12 split praised. Launch bonus discussed.", requestOrBlocker: null, priority: "high" as const },
     { meetingId: dm1.id, topicId: pt5.id, sentiment: "positive" as const, feedbackSummary: "Marketing co-op requested and viewed as a strong differentiator.", requestOrBlocker: "Needs co-marketing proposal", priority: "high" as const },
     { meetingId: dm2.id, topicId: pt2.id, sentiment: "negative" as const, feedbackSummary: "Discoverability concerns — previous titles underperformed on EGS.", requestOrBlocker: "Need conversion rate data", priority: "high" as const },
     { meetingId: dm3.id, topicId: pt1.id, sentiment: "positive" as const, feedbackSummary: "Exclusivity window compromise at 60 days with enhanced featuring.", requestOrBlocker: null, priority: "high" as const },
    ].forEach(mt => {
      const id = this.getId();
      this.meetingTopics.set(id, { id, createdAt: new Date(), updatedAt: new Date(), ...mt });
    });

    // Dummy source documents
    const dsd1: SourceDocument = { id: this.getId(), eventId: dummyE1.id, sourceType: "pasted_text", originalFileName: null, externalUrl: null, storagePathOrId: null, uploadedByUserId: u3.id, uploadedAt: new Date(), parsingStatus: "success", parsingLog: "AI extraction complete. Meetings: 2 · Companies: 2 · Contacts: 2 · Games: 2 · Topics: 3", rawTextExcerpt: "E3 2025 Trip Report — Sam Park\n\n### Meeting: Acme Interactive (Jane Doe)\nDate: June 11, 10:00 AM\nSentiment: Positive...", rawText: null };
    const dsd2: SourceDocument = { id: this.getId(), eventId: dummyE2.id, sourceType: "pasted_text", originalFileName: null, externalUrl: null, storagePathOrId: null, uploadedByUserId: u2.id, uploadedAt: new Date(), parsingStatus: "success", parsingLog: "AI extraction complete. Meetings: 1 · Companies: 1 · Contacts: 1 · Games: 1 · Topics: 1", rawTextExcerpt: "Nordic Game 2025 Trip Report — Jordan Rivera\n\n### Meeting: Fjord Studios (Erik Lindgren)\nDate: May 21, 11:00 AM\nSentiment: Positive...", rawText: null };
    [dsd1, dsd2].forEach(sd => this.sourceDocuments.set(sd.id, sd));

    // Dummy executive summaries
    const des1: EventExecutiveSummary = {
      id: this.getId(), eventId: dummyE1.id,
      macroThemes: "Mixed signals at E3: indie developers receptive to EGS revenue share, but mid-tier publishers still cautious about discoverability. Marketing co-promotion emerging as a key differentiator.",
      highlights: "Acme Interactive strongly interested in launching Starfall Chronicles on EGS. 88/12 revenue share praised. Timeline aligned for Q1 2026.",
      negatives: "Fjord Studios skeptical about EGS conversion rates vs Steam. Previous title performance on EGS was below expectations.",
      recommendations: "1. Prepare a comprehensive EGS conversion/wishlist data deck for hesitant publishers. 2. Develop a co-marketing proposal template for indie partners. 3. Schedule data-sharing session with Fjord Studios.",
      topOpportunities: ["Starfall Chronicles (Acme) — Q1 2026 launch, in negotiation", "Frozen Tides (Fjord) — cautiously optimistic, needs data"],
      topRisks: ["Fjord Studios may stay Steam-only if data doesn't convince them", "Co-marketing budget needs internal approval"],
      topActions: [
        { action: "Send marketing co-op proposal to Acme", owner: "Sam Park", dueDate: "2025-07-01" },
        { action: "Prepare conversion rate deck for Fjord", owner: "Sam Park", dueDate: "2025-07-15" },
      ],
      citationMap: null,
      generatedAt: new Date(), lastRefreshedAt: new Date(),
    };
    this.execSummaries.set(dummyE1.id, des1);
  }

  // ── Users ──
  async getUsers(): Promise<User[]> { return [...this.users.values()]; }
  async getUserById(id: number): Promise<User | undefined> { return this.users.get(id); }
  async createUser(data: InsertUser): Promise<User> {
    const user: User = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), ...data };
    this.users.set(user.id, user);
    return user;
  }

  // ── Events ──
  private computeEventStats(event: Event): EventWithStats {
    const eventMeetings = [...this.meetings.values()].filter(m => m.eventId === event.id);
    const sources = [...this.sourceDocuments.values()].filter(s => s.eventId === event.id);
    const owner = event.primaryOwnerUserId ? this.users.get(event.primaryOwnerUserId) : null;
    return {
      ...event,
      primaryOwner: owner ?? null,
      meetingCount: eventMeetings.length,
      positiveCount: eventMeetings.filter(m => m.overallSentiment === "positive").length,
      neutralCount: eventMeetings.filter(m => m.overallSentiment === "neutral").length,
      negativeCount: eventMeetings.filter(m => m.overallSentiment === "negative").length,
      sourceDocumentCount: sources.length,
      hasExecutiveSummary: this.execSummaries.has(event.id),
    };
  }

  async getEvents(): Promise<EventWithStats[]> {
    return [...this.events.values()].map(e => this.computeEventStats(e))
      .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
  }

  async getEventById(id: number): Promise<Event | undefined> { return this.events.get(id); }

  async getEventWithStats(id: number): Promise<EventWithStats | undefined> {
    const e = this.events.get(id);
    return e ? this.computeEventStats(e) : undefined;
  }

  async createEvent(data: InsertEvent): Promise<Event> {
    const event: Event = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), description: null, startDate: null, endDate: null, city: null, country: null, primaryOwnerUserId: null, isDummy: false, ...data };
    this.events.set(event.id, event);
    return event;
  }

  async updateEvent(id: number, data: Partial<InsertEvent>): Promise<Event> {
    const existing = this.events.get(id);
    if (!existing) throw new Error(`Event ${id} not found`);
    const updated = { ...existing, ...data, updatedAt: new Date() };
    this.events.set(id, updated);
    return updated;
  }

  async deleteEvent(id: number): Promise<void> { this.events.delete(id); }

  // ── EventAttendees ──
  async getEventAttendees(eventId: number): Promise<(EventAttendee & { user: User })[]> {
    return [...this.eventAttendees.values()]
      .filter(ea => ea.eventId === eventId)
      .map(ea => ({ ...ea, user: this.users.get(ea.userId)! }))
      .filter(ea => ea.user);
  }

  async addEventAttendee(data: InsertEventAttendee): Promise<EventAttendee> {
    const ea: EventAttendee = { id: this.getId(), ...data };
    this.eventAttendees.set(ea.id, ea);
    return ea;
  }

  // ── Companies ──
  async getCompanies(): Promise<Company[]> { return [...this.companies.values()]; }
  async getCompanyById(id: number): Promise<Company | undefined> { return this.companies.get(id); }
  async createCompany(data: InsertCompany): Promise<Company> {
    const company: Company = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), region: null, notes: null, ...data };
    this.companies.set(company.id, company);
    return company;
  }
  async updateCompany(id: number, data: Partial<InsertCompany>): Promise<Company> {
    const existing = this.companies.get(id);
    if (!existing) throw new Error(`Company ${id} not found`);
    const updated = { ...existing, ...data, updatedAt: new Date() };
    this.companies.set(id, updated);
    return updated;
  }

  // ── Contacts ──
  async getContactsByCompany(companyId: number): Promise<Contact[]> {
    return [...this.contacts.values()].filter(c => c.companyId === companyId);
  }
  async createContact(data: InsertContact): Promise<Contact> {
    const contact: Contact = { id: this.getId(), createdAt: new Date(), email: null, phone: null, notes: null, title: null, ...data };
    this.contacts.set(contact.id, contact);
    return contact;
  }

  // ── Meetings ──
  private enrichMeeting(m: Meeting): MeetingWithDetails {
    const company = m.companyId ? this.companies.get(m.companyId) ?? null : null;
    const mContacts = [...this.meetingContacts.values()]
      .filter(mc => mc.meetingId === m.id)
      .map(mc => ({ ...mc, contact: this.contacts.get(mc.contactId)! }))
      .filter(mc => mc.contact);
    const mGames = [...this.meetingGames.values()]
      .filter(mg => mg.meetingId === m.id)
      .map(mg => ({ ...mg, game: this.games.get(mg.gameId)! }))
      .filter(mg => mg.game);
    const mTopics = [...this.meetingTopics.values()]
      .filter(mt => mt.meetingId === m.id)
      .map(mt => ({ ...mt, topic: this.platformTopics.get(mt.topicId)! }))
      .filter(mt => mt.topic);
    const followUpOwner = m.followUpOwnerUserId ? this.users.get(m.followUpOwnerUserId) ?? null : null;
    return { ...m, company, contacts: mContacts, games: mGames, topics: mTopics, followUpOwner };
  }

  async getMeetingsByEvent(eventId: number): Promise<MeetingWithDetails[]> {
    return [...this.meetings.values()]
      .filter(m => m.eventId === eventId)
      .sort((a, b) => (a.meetingDate ?? "").localeCompare(b.meetingDate ?? ""))
      .map(m => this.enrichMeeting(m));
  }

  async getMeetingById(id: number): Promise<MeetingWithDetails | undefined> {
    const m = this.meetings.get(id);
    return m ? this.enrichMeeting(m) : undefined;
  }

  async createMeeting(data: InsertMeeting): Promise<Meeting> {
    const meeting: Meeting = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), companyId: null, meetingDate: null, startTime: null, endTime: null, location: null, summary: null, detailedNotes: null, followUpActions: null, followUpOwnerUserId: null, followUpDueDate: null, ...data };
    this.meetings.set(meeting.id, meeting);
    return meeting;
  }

  async updateMeeting(id: number, data: Partial<InsertMeeting>): Promise<Meeting> {
    const existing = this.meetings.get(id);
    if (!existing) throw new Error(`Meeting ${id} not found`);
    const updated = { ...existing, ...data, updatedAt: new Date() };
    this.meetings.set(id, updated);
    return updated;
  }

  async deleteMeeting(id: number): Promise<void> { this.meetings.delete(id); }

  async addMeetingContact(data: InsertMeetingContact): Promise<MeetingContact> {
    const mc: MeetingContact = { id: this.getId(), roleInMeeting: null, ...data };
    this.meetingContacts.set(mc.id, mc);
    return mc;
  }

  // ── Games ──
  async getGames(): Promise<Game[]> { return [...this.games.values()]; }
  async getGameById(id: number): Promise<Game | undefined> { return this.games.get(id); }
  async createGame(data: InsertGame): Promise<Game> {
    const game: Game = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), developerCompanyId: null, publisherCompanyId: null, notes: null, ...data };
    this.games.set(game.id, game);
    return game;
  }
  async updateGame(id: number, data: Partial<InsertGame>): Promise<Game> {
    const existing = this.games.get(id);
    if (!existing) throw new Error(`Game ${id} not found`);
    const updated = { ...existing, ...data, updatedAt: new Date() };
    this.games.set(id, updated);
    return updated;
  }

  async getGamesWithTouchpoints(): Promise<(Game & { touchpointCount: number; sentiments: string[]; events: string[] })[]> {
    const result: (Game & { touchpointCount: number; sentiments: string[]; events: string[] })[] = [];
    for (const game of this.games.values()) {
      const links = [...this.meetingGames.values()].filter(mg => mg.gameId === game.id);
      if (links.length === 0) continue;
      const sentiments = links.map(l => l.gameSpecificSentiment ?? "neutral");
      const eventNames: string[] = [];
      for (const link of links) {
        const mtg = this.meetings.get(link.meetingId);
        if (mtg) {
          const ev = this.events.get(mtg.eventId);
          if (ev && !eventNames.includes(ev.name)) eventNames.push(ev.name);
        }
      }
      result.push({ ...game, touchpointCount: links.length, sentiments, events: eventNames });
    }
    return result.sort((a, b) => b.touchpointCount - a.touchpointCount);
  }

  // ── MeetingGames ──
  async getMeetingGames(meetingId: number): Promise<(MeetingGame & { game: Game })[]> {
    return [...this.meetingGames.values()]
      .filter(mg => mg.meetingId === meetingId)
      .map(mg => ({ ...mg, game: this.games.get(mg.gameId)! }))
      .filter(mg => mg.game);
  }
  async addMeetingGame(data: InsertMeetingGame): Promise<MeetingGame> {
    const mg: MeetingGame = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), gameSpecificSentiment: null, discussionSummary: null, dealStatus: null, projectedLaunchTiming: null, keyQuotes: null, ...data };
    this.meetingGames.set(mg.id, mg);
    return mg;
  }
  async removeMeetingGame(id: number): Promise<void> { this.meetingGames.delete(id); }

  // ── PlatformTopics ──
  async getPlatformTopics(): Promise<PlatformTopic[]> { return [...this.platformTopics.values()]; }
  async createPlatformTopic(data: InsertPlatformTopic): Promise<PlatformTopic> {
    const topic: PlatformTopic = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), description: null, ...data };
    this.platformTopics.set(topic.id, topic);
    return topic;
  }

  async getTopicsWithStats(): Promise<(PlatformTopic & { feedbackCount: number; posCount: number; neutCount: number; negCount: number })[]> {
    return [...this.platformTopics.values()].map(topic => {
      const links = [...this.meetingTopics.values()].filter(mt => mt.topicId === topic.id);
      return {
        ...topic,
        feedbackCount: links.length,
        posCount: links.filter(l => l.sentiment === "positive").length,
        neutCount: links.filter(l => l.sentiment === "neutral").length,
        negCount: links.filter(l => l.sentiment === "negative").length,
      };
    }).filter(t => t.feedbackCount > 0).sort((a, b) => b.feedbackCount - a.feedbackCount);
  }

  // ── MeetingTopics ──
  async getMeetingTopics(meetingId: number): Promise<(MeetingTopic & { topic: PlatformTopic })[]> {
    return [...this.meetingTopics.values()]
      .filter(mt => mt.meetingId === meetingId)
      .map(mt => ({ ...mt, topic: this.platformTopics.get(mt.topicId)! }))
      .filter(mt => mt.topic);
  }
  async addMeetingTopic(data: InsertMeetingTopic): Promise<MeetingTopic> {
    const mt: MeetingTopic = { id: this.getId(), createdAt: new Date(), updatedAt: new Date(), requestOrBlocker: null, feedbackSummary: null, ...data };
    this.meetingTopics.set(mt.id, mt);
    return mt;
  }
  async removeMeetingTopic(id: number): Promise<void> { this.meetingTopics.delete(id); }

  // ── ExecutiveSummaries ──
  async getExecSummaryByEvent(eventId: number): Promise<EventExecutiveSummary | undefined> {
    return this.execSummaries.get(eventId);
  }
  async upsertExecSummary(data: InsertEventExecutiveSummary): Promise<EventExecutiveSummary> {
    const existing = this.execSummaries.get(data.eventId);
    const summary: EventExecutiveSummary = {
      id: existing?.id ?? this.getId(),
      generatedAt: existing?.generatedAt ?? new Date(),
      lastRefreshedAt: new Date(),
      macroThemes: null, highlights: null, negatives: null, recommendations: null,
      topOpportunities: null, topRisks: null, topActions: null,
      citationMap: null,
      ...data,
    };
    this.execSummaries.set(data.eventId, summary);
    return summary;
  }

  // ── GlobalSummaries ──
  async getLatestGlobalSummary(): Promise<GlobalSummary | undefined> {
    const summaries = [...this.globalSummaries.values()];
    return summaries.sort((a, b) => b.generatedAt!.getTime() - a.generatedAt!.getTime())[0];
  }
  async createGlobalSummary(data: InsertGlobalSummary): Promise<GlobalSummary> {
    const gs: GlobalSummary = { id: this.getId(), generatedAt: new Date(), gamesSummary: null, topicsSummary: null, keyRecommendations: null, ...data };
    this.globalSummaries.set(gs.id, gs);
    return gs;
  }

  // ── SourceDocuments ──
  async getSourceDocumentsByEvent(eventId: number): Promise<SourceDocument[]> {
    return [...this.sourceDocuments.values()]
      .filter(sd => sd.eventId === eventId)
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  }
  async getSourceDocumentById(id: number): Promise<SourceDocument | undefined> { return this.sourceDocuments.get(id); }
  async createSourceDocument(data: InsertSourceDocument): Promise<SourceDocument> {
    const sd: SourceDocument = { id: this.getId(), uploadedAt: new Date(), originalFileName: null, externalUrl: null, storagePathOrId: null, uploadedByUserId: null, parsingLog: null, rawTextExcerpt: null, rawText: null, ...data };
    this.sourceDocuments.set(sd.id, sd);
    return sd;
  }
  async updateSourceDocument(id: number, data: Partial<InsertSourceDocument>): Promise<SourceDocument> {
    const existing = this.sourceDocuments.get(id);
    if (!existing) throw new Error(`SourceDocument ${id} not found`);
    const updated = { ...existing, ...data };
    this.sourceDocuments.set(id, updated);
    return updated;
  }

  // ── ParsedSections ──
  async deleteSourceDocument(id: number): Promise<void> { this.sourceDocuments.delete(id); }

  async getParsedSectionsByDocument(sourceDocumentId: number): Promise<ParsedSection[]> {
    return [...this.parsedSections.values()].filter(ps => ps.sourceDocumentId === sourceDocumentId);
  }
  async createParsedSection(data: InsertParsedSection): Promise<ParsedSection> {
    const ps: ParsedSection = { id: this.getId(), createdAt: new Date(), linkedMeetingId: null, linkedGameId: null, linkedTopicId: null, sectionText: null, ...data };
    this.parsedSections.set(ps.id, ps);
    return ps;
  }
}

// Auto-select storage: Postgres when DATABASE_URL is set, otherwise in-memory.
export async function createStorage(): Promise<IStorage> {
  if (process.env.DATABASE_URL) {
    const { DatabaseStorage } = await import("./db-storage");
    return new DatabaseStorage();
  }
  return new MemStorage();
}

// Synchronous default export for backwards compat — overridden at startup via initStorage().
let _storage: IStorage = new MemStorage();
export const storage: IStorage = new Proxy({} as IStorage, {
  get(_target, prop) {
    return (_storage as any)[prop];
  },
});

export function initStorage(s: IStorage) {
  _storage = s;
}
