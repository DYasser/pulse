-- Runs once when the Postgres volume is first created.
-- Gives the integration tests their own database on the same server.
CREATE DATABASE pulse_test OWNER pulse;
