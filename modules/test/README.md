# Test module (throwaway)

Acceptance-test module for Batch 1 (spec §13): it proves a module can
register — tile + widget — with zero shell-code changes. It has no server
routes and no migrations; it only exercises the client-chunk contract
(`description`, `mount`, `widget`).

Lifecycle: it ships in the Batch 1 push, its registry row is inserted into
D1 after the deploy, the tile + widget are verified live, then the row is
deleted and this folder is removed in a follow-up push. It never ships.
