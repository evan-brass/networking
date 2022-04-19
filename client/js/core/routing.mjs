import { our_peerid } from "./peer-id.mjs";
import { lookup } from "./kbuckets.mjs";
import { siblings } from "./siblings.mjs";
import { PeerConnection } from "./peer-connection.mjs";
import { get_expiration } from "./lib.mjs";

// TODO: add a cache of messages that we've seen recently so that we don't handle the same message more than once.  I think we can do this using the body_sig of the message.  The cache also might belong in messages instead of routing.  The goal is to once again limit the affects of replay attacks.  The cache only needs to contain messaegs until they expire.



