/**
 * In this file we manage our list of outstanding connections: We keep a list of the body_sig for the request_connect messages that we send.
 * We also handle incoming connect messages by matching them with the request_connect that we sent.
 * Lastly, we evaluate incoming request_connect message by checking if there's space in our various routing tables for the connection.
 */