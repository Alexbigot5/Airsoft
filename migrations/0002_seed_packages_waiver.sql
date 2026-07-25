-- Seed data: packages taken from the site's published pricing, plus the first
-- waiver version.
--
-- NOTE: body_sha256 below is the SHA-256 of the body text exactly as stored. It
-- is what the signing endpoint compares against, so the two must be regenerated
-- together -- do not hand-edit the body in place. Publish new wording through
-- POST /api/admin/waiver-versions, which recomputes the hash, rather than by
-- editing this migration.

INSERT INTO packages (id, name, blurb, price_cents, includes_json, active, sort_order) VALUES
  ('walkon',  'Walk-On',  'per player · full game day',
   3500, '["Full game day access","Marshaled games","Chrono + safety brief"]', 1, 1),
  ('halfday', 'Half Day', 'per player · morning or afternoon',
   2500, '["One game block","Marshaled games","Great for first-timers"]', 1, 2);

INSERT INTO waiver_versions (version, body, body_sha256, active) VALUES
  ('2026-07-v1',
   'COYOTE RIDGE AIRSOFT — RELEASE OF LIABILITY, ASSUMPTION OF RISK, AND INDEMNITY AGREEMENT

PLEASE READ CAREFULLY BEFORE SIGNING. THIS IS A LEGAL DOCUMENT THAT AFFECTS YOUR LEGAL RIGHTS.

1. ACTIVITY
I am voluntarily participating in airsoft activities at Coyote Ridge Airsoft ("the Field"), including gameplay, spectating, equipment handling, chronograph testing, safety briefings, and movement on and around the property.

2. ASSUMPTION OF RISK
I understand that airsoft is a physically demanding activity conducted on uneven outdoor terrain and inside close-quarters structures, and that it carries inherent risks that cannot be eliminated. These include, without limitation: impact injuries from projectiles travelling at high speed; eye, ear, dental and facial injury; slips, trips and falls; collision with other participants, structures or terrain; heat, cold and weather exposure; insect and animal encounters; equipment malfunction; and the negligent acts of other participants. I knowingly and freely assume all such risks, both known and unknown.

3. EYE AND FACE PROTECTION
I understand that full-seal, ANSI Z87.1+ rated eye protection must be worn at all times within any designated game area, and that removing eye protection in a live area may cause permanent blindness. Participants under 18 must wear full-seal eye protection and full face protection. I agree to comply without exception.

4. VELOCITY LIMITS AND CHRONOGRAPH
I understand that every replica must be chronographed and inspected by staff before entering the field, that published velocity and engagement-distance limits exist for participant safety, and that defeating, bypassing or altering a replica after inspection is grounds for immediate removal without refund.

5. RULES AND MARSHAL AUTHORITY
I agree to follow all posted field rules, the safety briefing, and the instructions of marshals and staff at all times. I understand that staff may remove me from the property, without refund, for unsafe conduct, intoxication, aggression, cheating, or refusal to follow instructions.

6. FITNESS AND MEDICAL
I confirm that I am physically able to participate and that I have disclosed any medical condition relevant to my safety. I authorise the Field and its staff to arrange emergency medical treatment on my behalf if I am unable to consent, and I accept financial responsibility for that treatment.

7. RELEASE AND WAIVER
To the fullest extent permitted by Oregon law, I release, waive, and discharge Coyote Ridge Airsoft, its owners, operators, employees, marshals, volunteers, landowners and affiliates (the "Released Parties") from any and all liability, claims, demands, or causes of action arising out of or related to any loss, damage, injury, or death sustained in connection with my participation, INCLUDING CLAIMS ARISING FROM THE ORDINARY NEGLIGENCE OF THE RELEASED PARTIES. This release does not apply to gross negligence, recklessness, or wilful misconduct, nor to any liability that cannot lawfully be waived.

8. INDEMNIFICATION
I agree to indemnify and hold harmless the Released Parties from any loss, liability, damage or cost, including reasonable attorneys'' fees, arising out of my participation or my breach of this agreement, including damage I cause to property or to another participant.

9. PROPERTY
I am solely responsible for my own equipment. The Released Parties are not liable for loss, theft, or damage to personal property brought onto the premises.

10. MEDIA
I grant the Field permission to use photographs and video in which I appear, taken on the premises, for promotional purposes without compensation. I may withdraw this permission in writing.

11. MINORS
Participants aged 12 through 17 may participate only with a parent or legal guardian present on site and only with this agreement signed by that parent or legal guardian. By signing on behalf of a minor, I confirm I am the parent or legal guardian, I accept these terms on the minor''s behalf and on my own behalf, and I agree to supervise the minor for the duration of their attendance. Participants aged 18 and over may sign for themselves.

12. TERM
This agreement remains in effect for twelve (12) months from the date signed, and applies to every visit I make during that period.

13. SEVERABILITY AND GOVERNING LAW
This agreement is governed by the laws of the State of Oregon. If any provision is held unenforceable, the remaining provisions remain in full force.

14. ACKNOWLEDGEMENT
I have read this entire agreement. I understand that I am giving up substantial legal rights, including the right to sue. I sign it freely and voluntarily, without inducement. I understand that typing my full legal name below constitutes my electronic signature and is intended to have the same legal effect as a handwritten signature.',
   '0d36c619cbbca6a1e0d0df61f35c769f48ab2981d0aee725fb930f5356a62aba',
   1);
