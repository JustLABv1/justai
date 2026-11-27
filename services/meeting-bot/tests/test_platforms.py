import unittest

from meeting_bot.platforms import parse_participant_count


class ParticipantCountTests(unittest.TestCase):
    def test_reads_counts_from_labels(self):
        cases = {
            # The Cisco Meeting Server web app at meet.bdbos.bund.de, 27 Nov 2026.
            "3 Teilnehmer im Meeting, 0 Teilnehmer mit erhobener Hand und Teilnehmer in der Lobby | Teilnehmende": 3,
            "1 Teilnehmer im Meeting, 0 Teilnehmer mit erhobener Hand": 1,
            "Teilnehmende (4)": 4,
            "12 participants": 12,
            "Participants (2)": 2,
            "Teilnehmende hinzufügen | Teilnehmende hinzufügen": None,
            "": None,
        }
        for label, want in cases.items():
            self.assertEqual(parse_participant_count(label), want, label)


if __name__ == "__main__":
    unittest.main()
