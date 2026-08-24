import { describe, it, expect } from "vitest";
import { serializeStatus } from "@/lib/mastodon/serializers";
import type { LocalObject, LocalActor, LocalAttachment } from "@/lib/types";

function buildActor(): LocalActor {
  return {
    id: "https://mastodon.social/users/Karma_J",
    username: "karma_j",
    domain: "mastodon.social",
    displayName: "Janie Karma S",
    summary: "<p>bio</p>",
    avatarUrl: "https://files.mastodon.social/.../avatar.png",
    headerUrl: null,
    isLocal: false,
    isBot: false,
    manuallyApprovesFollowers: false,
    discoverable: true,
    followersCount: 0,
    followingCount: 0,
    statusesCount: 0,
    createdAt: "2026-07-02 18:44:43",
    role: "user",
    suspended: false,
    silenced: false,
    reserved: false,
    movedTo: null,
    raw: "{}",
    inbox: "",
    publicKeyPem: "",
    privateKeyPem: null,
  } as unknown as LocalActor;
}

function buildObject(): LocalObject {
  return {
    id: "https://mastodon.social/users/Karma_J/statuses/116851859836775829",
    type: "Note",
    actorId: "https://mastodon.social/users/Karma_J",
    content: '<p><span class="h-card" translate="no"><a href="https://techhub.social/@linuxgal" class="u-url mention">@<span>linuxgal</span></a></span></p>',
    contentWarning: null,
    sensitive: true,
    visibility: "public",
    inReplyToId: "https://techhub.social/users/linuxgal/statuses/116851833610278481",
    language: null,
    url: "https://mastodon.social/@Karma_J/116851859836775829",
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-07-02T18:44:40.000Z",
    updatedAt: "2026-07-02T18:44:40.000Z",
    local: false,
    raw: "{}",
  } as unknown as LocalObject;
}

describe("remote status serialization (federated video + sensitive)", () => {
  it("does not mark a status as edited when updated_at equals published", () => {
    const s = serializeStatus(buildObject(), buildActor(), "mastodon.social", { favourited: false, reblogged: false, emojis: [] });
    expect(s.edited_at).toBeNull();
  });

  it("serializes content and the remote video attachment", () => {
    const att = {
      id: "33ec3256-635b-4071-8051-3d2b804977c5",
      objectId: buildObject().id,
      type: "video",
      url: "https://files.mastodon.social/.../5929a551f98f655e.mp4",
      remoteUrl: "https://files.mastodon.social/.../5929a551f98f655e.mp4",
      description: null,
      blurhash: null,
      width: null,
      height: null,
      fileSize: null,
      mimeType: "video/mp4",
      sensitive: false,
      createdAt: "2026-07-02 18:44:45",
    } as unknown as LocalAttachment;

    const s = serializeStatus(buildObject(), buildActor(), "mastodon.social", {
      attachments: [att],
      favourited: false,
      reblogged: false,
      emojis: [],
    });

    expect(s.content).toContain("linuxgal");
    expect(s.sensitive).toBe(true);
    expect(s.media_attachments).toHaveLength(1);
    expect(s.media_attachments[0].type).toBe("video");
  });
});