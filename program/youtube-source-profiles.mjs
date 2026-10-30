// Source profiles keep channel identity and publication routing in one place.
// The transcript/summary pipeline remains shared; a new source only needs a
// profile and a thin runner wrapper.

const DEFAULT_PROFILE_ID = "andrii";

export const YOUTUBE_SOURCE_PROFILES = Object.freeze({
  andrii: Object.freeze({
    id: "andrii",
    source_slug: "andrii-zvorygin",
    topic_slug: "general",
    community_name: "andrii-zvorygin",
    jurisdiction: "Andrii Zvorygin",
    body: "Livestream",
    site_url: "https://andrii.zvorygin.ca",
    source_channel_url: "https://www.youtube.com/@AndriiZ/streams",
  }),
  "owen-sound-police": Object.freeze({
    id: "owen-sound-police",
    source_slug: "owen-sound-police",
    topic_slug: "police-board",
    community_name: "owen_sound_police",
    jurisdiction: "Owen Sound Police",
    body: "Police Services Board",
    site_url: "https://helpos.ca",
    source_channel_url: "https://www.youtube.com/@owensoundpolice8677/streams",
  }),
  "owen-sound-council": Object.freeze({
    id: "owen-sound-council",
    source_slug: "owen-sound",
    topic_slug: "council-meeting",
    community_name: "owen-sound-council",
    jurisdiction: "Owen Sound",
    body: "Council",
    site_url: "https://helpos.ca",
    source_channel_url: "https://www.youtube.com/@AndriiZ/streams",
  }),
});

function clean(value) {
  return String(value || "").trim();
}

export function activeYoutubeSourceProfile() {
  const requested = clean(process.env.ANDRII_SOURCE_PROFILE || DEFAULT_PROFILE_ID).toLowerCase();
  const profile = YOUTUBE_SOURCE_PROFILES[requested] || YOUTUBE_SOURCE_PROFILES[DEFAULT_PROFILE_ID];
  return {
    ...profile,
    id: requested in YOUTUBE_SOURCE_PROFILES ? requested : DEFAULT_PROFILE_ID,
    source_slug: clean(process.env.ANDRII_SOURCE_SLUG || profile.source_slug),
    topic_slug: clean(process.env.ANDRII_TOPIC_SLUG || profile.topic_slug),
    community_name: clean(process.env.ANDRII_COMMUNITY_NAME || profile.community_name),
    source_channel_url: clean(process.env.ANDRII_SOURCE_CHANNEL_URL || profile.source_channel_url),
  };
}

export function sourceProfileDefaults() {
  const profile = activeYoutubeSourceProfile();
  return {
    jurisdiction: clean(process.env.ANDRII_JURISDICTION || profile.jurisdiction),
    body: clean(process.env.ANDRII_BODY || profile.body),
    site_url: clean(process.env.ANDRII_SITE_URL || profile.site_url),
  };
}
