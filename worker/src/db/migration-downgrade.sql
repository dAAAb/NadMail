-- Migration: Downgrade illegitimate handles to 0x addresses
-- Run via: npx wrangler d1 execute nadmail-db --file=src/db/migration-downgrade.sql

PRAGMA foreign_keys = OFF;

-- testa → 0x82b83cda
UPDATE emails SET handle = '0x82b83cda' WHERE handle = 'testa';
UPDATE daily_email_counts SET handle = '0x82b83cda' WHERE handle = 'testa';
UPDATE credit_transactions SET handle = '0x82b83cda' WHERE handle = 'testa';
UPDATE daily_emobuy_totals SET handle = '0x82b83cda' WHERE handle = 'testa';
UPDATE accounts SET handle = '0x82b83cda', nad_name = NULL, previous_handle = 'testa' WHERE wallet = '0x82b83cda4119d380f9c3c43f7a2bd93c282a496d';

-- testb → 0x69745e60
UPDATE emails SET handle = '0x69745e60' WHERE handle = 'testb';
UPDATE daily_email_counts SET handle = '0x69745e60' WHERE handle = 'testb';
UPDATE credit_transactions SET handle = '0x69745e60' WHERE handle = 'testb';
UPDATE daily_emobuy_totals SET handle = '0x69745e60' WHERE handle = 'testb';
UPDATE accounts SET handle = '0x69745e60', nad_name = NULL, previous_handle = 'testb' WHERE wallet = '0x69745e604b0f43144c292b2e27c7e0217c0dc6ad';

-- alicemtfv → 0x26027c61
UPDATE emails SET handle = '0x26027c61' WHERE handle = 'alicemtfv';
UPDATE daily_email_counts SET handle = '0x26027c61' WHERE handle = 'alicemtfv';
UPDATE credit_transactions SET handle = '0x26027c61' WHERE handle = 'alicemtfv';
UPDATE daily_emobuy_totals SET handle = '0x26027c61' WHERE handle = 'alicemtfv';
UPDATE accounts SET handle = '0x26027c61', nad_name = NULL, previous_handle = 'alicemtfv' WHERE wallet = '0x26027c61920c589682c8c5456dcd7b7e71bac6b6';

-- bobmtfv → 0xabe17af1
UPDATE emails SET handle = '0xabe17af1' WHERE handle = 'bobmtfv';
UPDATE daily_email_counts SET handle = '0xabe17af1' WHERE handle = 'bobmtfv';
UPDATE credit_transactions SET handle = '0xabe17af1' WHERE handle = 'bobmtfv';
UPDATE daily_emobuy_totals SET handle = '0xabe17af1' WHERE handle = 'bobmtfv';
UPDATE accounts SET handle = '0xabe17af1', nad_name = NULL, previous_handle = 'bobmtfv' WHERE wallet = '0xabe17af10da8820e28c4b8a035f0c09c8154b8ef';

-- alicesrxb → 0x210cba47
UPDATE emails SET handle = '0x210cba47' WHERE handle = 'alicesrxb';
UPDATE daily_email_counts SET handle = '0x210cba47' WHERE handle = 'alicesrxb';
UPDATE credit_transactions SET handle = '0x210cba47' WHERE handle = 'alicesrxb';
UPDATE daily_emobuy_totals SET handle = '0x210cba47' WHERE handle = 'alicesrxb';
UPDATE accounts SET handle = '0x210cba47', nad_name = NULL, previous_handle = 'alicesrxb', token_symbol = '0X210CBA47' WHERE wallet = '0x210cba47cf8a8657e9f7c7ceaf2b36f99a82f2f7';

-- bobsrxb → 0x04595d78
UPDATE emails SET handle = '0x04595d78' WHERE handle = 'bobsrxb';
UPDATE daily_email_counts SET handle = '0x04595d78' WHERE handle = 'bobsrxb';
UPDATE credit_transactions SET handle = '0x04595d78' WHERE handle = 'bobsrxb';
UPDATE daily_emobuy_totals SET handle = '0x04595d78' WHERE handle = 'bobsrxb';
UPDATE accounts SET handle = '0x04595d78', nad_name = NULL, previous_handle = 'bobsrxb', token_symbol = '0X04595D78' WHERE wallet = '0x04595d782a9110976163126b375c39c406cc2b4d';

-- testagent1 → 0xc85cfc40
UPDATE emails SET handle = '0xc85cfc40' WHERE handle = 'testagent1';
UPDATE daily_email_counts SET handle = '0xc85cfc40' WHERE handle = 'testagent1';
UPDATE credit_transactions SET handle = '0xc85cfc40' WHERE handle = 'testagent1';
UPDATE daily_emobuy_totals SET handle = '0xc85cfc40' WHERE handle = 'testagent1';
UPDATE accounts SET handle = '0xc85cfc40', nad_name = NULL, previous_handle = 'testagent1', token_symbol = '0XC85CFC40' WHERE wallet = '0xc85cfc400334ab5cfc55ca7da8bca44b51f332d2';

-- testagent2 → 0xcd86d026
UPDATE emails SET handle = '0xcd86d026' WHERE handle = 'testagent2';
UPDATE daily_email_counts SET handle = '0xcd86d026' WHERE handle = 'testagent2';
UPDATE credit_transactions SET handle = '0xcd86d026' WHERE handle = 'testagent2';
UPDATE daily_emobuy_totals SET handle = '0xcd86d026' WHERE handle = 'testagent2';
UPDATE accounts SET handle = '0xcd86d026', nad_name = NULL, previous_handle = 'testagent2', token_symbol = '0XCD86D026' WHERE wallet = '0xcd86d026ea964ef560ac6af7d49470a9e162b25c';

-- openclaw → 0x953f1f18
UPDATE emails SET handle = '0x953f1f18' WHERE handle = 'openclaw';
UPDATE daily_email_counts SET handle = '0x953f1f18' WHERE handle = 'openclaw';
UPDATE credit_transactions SET handle = '0x953f1f18' WHERE handle = 'openclaw';
UPDATE daily_emobuy_totals SET handle = '0x953f1f18' WHERE handle = 'openclaw';
UPDATE accounts SET handle = '0x953f1f18', nad_name = NULL, previous_handle = 'openclaw', token_symbol = '0X953F1F18' WHERE wallet = '0x953f1f18a96ce3977d29476f74c84b34075d2441';

PRAGMA foreign_keys = ON;
