-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Erstellungszeit: 06. Mai 2025 um 18:00
-- Server-Version: 10.4.32-MariaDB
-- PHP-Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Datenbank: `chessy`
--

-- --------------------------------------------------------

--
-- Tabellenstruktur für Tabelle `active_games`
--

CREATE TABLE `active_games` (
  `id` int(11) NOT NULL,
  `game_uuid` varchar(255) NOT NULL,
  `challenger_id` varchar(255) NOT NULL,
  `challenged_id` varchar(255) NOT NULL,
  `white_player_id` varchar(255) NOT NULL,
  `black_player_id` varchar(255) NOT NULL,
  `fen` text NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `game_status` enum('not started','started','game end') DEFAULT 'not started',
  `winner_id` varchar(255) DEFAULT NULL,
  `loser_id` varchar(255) DEFAULT NULL,
  `game_result` varchar(50) DEFAULT NULL,
  `elo_score_winner_before` int(11) DEFAULT NULL,
  `elo_score_winner_after` int(11) DEFAULT NULL,
  `elo_score_loser_before` int(11) DEFAULT NULL,
  `elo_score_loser_after` int(11) DEFAULT NULL,
  `guild_id` varchar(20) NOT NULL,
  `message_id` varchar(255) DEFAULT NULL,
  `game_started_message_id` varchar(255) DEFAULT NULL,
  `selected_time` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Tabellenstruktur für Tabelle `bot_guilds`
--

CREATE TABLE `bot_guilds` (
  `id` int(11) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `guild_name` varchar(255) DEFAULT NULL,
  `invite_link` varchar(255) DEFAULT NULL,
  `owner_id` varchar(255) DEFAULT NULL,
  `added_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL,
  `active_matches_channel` varchar(255) DEFAULT NULL,
  `challenges_channel` varchar(255) DEFAULT NULL,
  `leaderboard_channel` varchar(255) DEFAULT NULL,
  `finished_matches_channel` varchar(255) DEFAULT NULL,
  `premium` enum('yes','no') DEFAULT 'no',
  `leaderboard_message_id` varchar(255) DEFAULT NULL,
  `is_in_guild` enum('yes','no') DEFAULT 'yes',
  `defined_roles` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Tabellenstruktur für Tabelle `challenges`
--

CREATE TABLE `challenges` (
  `id` int(11) NOT NULL,
  `challenge_uuid` varchar(255) NOT NULL,
  `message_id` varchar(255) NOT NULL,
  `challenger_id` varchar(255) NOT NULL,
  `challenged_id` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `selected_time` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Tabellenstruktur für Tabelle `players`
--

CREATE TABLE `players` (
  `id` int(11) NOT NULL,
  `discord_id` varchar(50) DEFAULT NULL,
  `elo` int(11) NOT NULL DEFAULT 1000,
  `status` enum('active','timed out','banned') DEFAULT 'active',
  `time_out` datetime DEFAULT NULL,
  `reason` text DEFAULT NULL,
  `supporter` enum('no','tier 1','tier 2','tier 3') DEFAULT 'no',
  `type` enum('player','admin','team') NOT NULL DEFAULT 'player',
  `username` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Tabellenstruktur für Tabelle `settings`
--

CREATE TABLE `settings` (
  `id` int(11) NOT NULL,
  `anonymous_mode` enum('yes','no') NOT NULL DEFAULT 'no'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Daten für Tabelle `settings`
--

INSERT INTO `settings` (`id`, `anonymous_mode`) VALUES
(1, 'yes');

-- --------------------------------------------------------

--
-- Tabellenstruktur für Tabelle `wins`
--

CREATE TABLE `wins` (
  `id` int(11) NOT NULL,
  `discord_id` varchar(255) NOT NULL,
  `guild_id` varchar(255) NOT NULL,
  `game_uuid` varchar(255) NOT NULL,
  `date` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Indizes der exportierten Tabellen
--

--
-- Indizes für die Tabelle `active_games`
--
ALTER TABLE `active_games`
  ADD PRIMARY KEY (`id`);

--
-- Indizes für die Tabelle `bot_guilds`
--
ALTER TABLE `bot_guilds`
  ADD PRIMARY KEY (`id`);

--
-- Indizes für die Tabelle `challenges`
--
ALTER TABLE `challenges`
  ADD PRIMARY KEY (`id`);

--
-- Indizes für die Tabelle `players`
--
ALTER TABLE `players`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `discord_id` (`discord_id`);

--
-- Indizes für die Tabelle `settings`
--
ALTER TABLE `settings`
  ADD PRIMARY KEY (`id`);

--
-- Indizes für die Tabelle `wins`
--
ALTER TABLE `wins`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT für exportierte Tabellen
--

--
-- AUTO_INCREMENT für Tabelle `active_games`
--
ALTER TABLE `active_games`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=232;

--
-- AUTO_INCREMENT für Tabelle `bot_guilds`
--
ALTER TABLE `bot_guilds`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT für Tabelle `challenges`
--
ALTER TABLE `challenges`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=291;

--
-- AUTO_INCREMENT für Tabelle `players`
--
ALTER TABLE `players`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT für Tabelle `settings`
--
ALTER TABLE `settings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT für Tabelle `wins`
--
ALTER TABLE `wins`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=47;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
