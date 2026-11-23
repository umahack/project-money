# Requirements Document

## Introduction

Project Money already explains what is safe to spend (see the Financial Clarity Experience spec), but recording an expense still means opening Spending, filling a form, and then reading a monthly number that does not say what the entry changed today. Users who track their money by typing need a faster way to add an entry and an immediate, plain answer to "what does this mean for me today?"

This feature, Quick Add and Daily Answer, delivers three connected capabilities for salaried individuals who track monthly money:

1. **Quick Add**: a single-line input such as `120 coffee`, `swiggy 450 yesterday`, or `rent 25,000 on 3rd`, reachable from every signed-in page, that shows what was understood and saves one expense.
2. **Immediate answer**: after each confirmed save, a short answer built only from server-calculated values: today's spend against today's allowance, what is left today, and the status of the Needs or Wants budget the entry belongs to.
3. **Home headline**: "You can spend ₹X today", the first outcome on the clarity Home, with today's spend, what is left, and a progress indicator.

Alignment with the existing Financial Clarity Experience requirements:

- Saves, corrections, and undo reuse the existing expense create, update, and delete mutations, including `Idempotency-Key`, `X-Clarity-Contract`, scoped status, and rollback behavior. This feature adds no second path for writing expenses.
- Every money value shown is an integer-paise value calculated by the server. The browser formats and labels values. It never adds, subtracts, or divides money.
- The existing Daily_Spending_Guide is not changed. Today_Allowance is defined from the same inputs and rounding (see the Glossary) and is added next to it as an additive outcome.
- Requirement 12.1 of the Financial Clarity Experience orders the Core_Promise before Financial_Outcomes and Financial_Outcomes before primary actions. To stay consistent, the Home_Headline is the first Financial_Outcome and the Quick_Add_Input sits directly below it as the first primary action. "Top of Home" in this spec means that position.
- The product time zone is Asia/Kolkata. The existing Home derives its month from the device clock. This feature requires "today" and the Home month to come from Asia/Kolkata so the browser and server agree on the same day.
- Quick Add and the Home_Headline are released together behind one feature switch that has a client half, the Quick_Add_Flag, and a server half, the Quick_Add_Server_Flag. Both are off by default. The client half has an effect only while the Rollout_Flag is also on. Switching the client half off restores the clarity Home exactly as it was before this feature and loses no saved data. There is no separate switch for the Home_Headline.
- A large or bill-like entry is always recorded in the month. The User may save it with an Allowance_Exclusion, an explicit and visible mark that keeps the expense out of Today_Spent only. Every monthly total, Needs or Wants bucket, and projection counts the expense as usual.
- An expense that a recurring definition posts automatically is marked with the Allowance_Exclusion when it is posted, because a rent or subscription payment that falls due on a day is not a spending choice of that day. It still counts in every monthly total, Needs or Wants bucket, and projection, and the User can clear the mark.
- While the Rollout_Flag is on, the Current_Month on every clarity page comes from the Asia/Kolkata calendar, so Home, Plan, Spending, Goals, and Trips agree with the server.
- The decisions recorded in the Owner Decisions section are integrated into the requirements below.

Out of scope for this spec, and listed again at the end: reminders and emails, push notifications, an installable PWA, a weekly money story, import from SMS, UPI, or CSV, shared budgets, and net worth.

## Glossary

- **Financial_Clarity_Experience**: The existing connected Project Money experience defined in the Financial Clarity Experience requirements.
- **Success_Measurement**: The existing product capability that reports adoption, responsiveness, and action metrics for the Financial_Clarity_Experience.
- **Existing_Terms**: Daily_Spending_Guide, Spendable_Budget, Needs_Budget, Wants_Budget, Current_Month, Expense_Data, Disposable_Income, Financial_Outcome, Financial_Record_Change, Scoped_Feedback, Calculation_Explanation, Data_Use_Notice, Product_Analytics, Stale_Data, and Monthly_Clarity_Summary keep the meaning given in the Financial Clarity Experience requirements.
- **User**: A signed-in Project Money account holder.
- **Rollout_Flag**: The client feature flag `VITE_FINANCIAL_CLARITY_ENABLED` that selects the clarity experience over the legacy experience.
- **Quick_Add_Flag**: The client feature flag `VITE_QUICK_ADD_ENABLED`. It is off when absent, malformed, or any value other than `1` or `true` (without regard to letter case), the same fail-closed reading the Rollout_Flag uses.
- **Quick_Add_Server_Flag**: The server environment flag `QUICK_ADD_ENABLED`. It is off when absent, malformed, or any value other than `1` or `true` (without regard to letter case). While it is on, the Memory_API accepts writes and the current Data_Use_Notice is the Category_Memory_Notice.
- **Category_Memory_Notice**: The version of the Data_Use_Notice that adds the category memory data category. It is the current notice version only while the Quick_Add_Server_Flag is on.
- **Quick_Add_Enabled**: The state in which both the Rollout_Flag and the Quick_Add_Flag are on. Every Quick_Add surface and the Home_Headline exist only in this state.
- **Data_Use_Gate**: The existing mechanism that pauses new financial inputs until the User has reviewed the current Data_Use_Notice.
- **Today**: The current calendar date in the Asia/Kolkata time zone.
- **Accepted_Date_Range**: The dates from 1 January through 31 December of the years from Today's year minus 10 through Today's year plus 1, the range the existing expense form and expense API accept.
- **Quick_Add**: The one-line expense entry capability, including the input, preview, category suggestion, save, undo, and answer behavior in this document.
- **Quick_Add_Input**: The single-line text field in which the User types a Quick_Add_Line.
- **Quick_Add_Line**: The text the User types into Quick_Add_Input, at most 200 characters.
- **Floating_Action**: A fixed-position control, shown while the bottom tab bar is displayed, that opens Quick_Add.
- **Quick_Add_Shortcut**: The keyboard combination Ctrl + K, or Cmd + K on Apple platforms (macOS and iPadOS), that opens or focuses Quick_Add on every signed-in page at every viewport width.
- **Quick_Add_Parser**: A pure function that converts a Quick_Add_Line and Today into a Parse_Result.
- **Quick_Add_Formatter**: A pure function that converts a Parsed_Entry into a canonical Quick_Add_Line.
- **Parse_Result**: Either a Parsed_Entry or a non-empty list of Parse_Problems.
- **Parsed_Entry**: An amount in integer paise, a date, and a Note_Text that may be empty.
- **Parse_Problem**: A code, the part of the Quick_Add_Line affected, the reason, and the accepted correction.
- **Amount_Token**: A token of the Quick_Add_Line interpreted as the amount, written as an optional currency marker, a number, and an optional `/-` suffix.
- **Currency_Marker**: One of `₹`, `Rs`, `Rs.`, or `INR`, matched without regard to letter case, attached directly before the number or written as the token immediately before the number.
- **Date_Token**: A token or token pair of the Quick_Add_Line interpreted as the date: `today`, `yesterday`, a full weekday name, `on N`, an ordinal such as `3rd`, `dd/mm`, `dd/mm/yy`, `dd/mm/yyyy`, or `yyyy-mm-dd`.
- **Note_Text**: The text of the Quick_Add_Line that is neither the Amount_Token, a Currency_Marker, nor a Date_Token, kept exactly as the User typed it (no Unicode normalization and no change of letter case), with whitespace runs collapsed to one space and the ends trimmed.
- **Entry_Preview**: The display of the amount, category with its reason, date, and Note_Text that the Quick_Add_Parser and Category_Suggester produced for the current Quick_Add_Line.
- **Note_Key**: The Note_Text normalized with Unicode NFKC, with whitespace runs collapsed to one space, lower-cased using `en-IN` rules, and trimmed, at most 60 Unicode code points. An empty Note_Text, and a Note_Text whose normalized form is longer than 60 code points, has no Note_Key.
- **Default_Category**: The built-in category `Other`.
- **Category_Suggestion**: One category together with its source (memory, history, category_name, keyword, or default) and a plain-language reason.
- **Category_Suggester**: The deterministic function that produces a Category_Suggestion from a Parsed_Entry, the User's available categories, Category_Memory, Category_History, and the built-in keyword rules.
- **Keyword_Rules**: A fixed list, shipped with the application, that maps whole words or phrases to built-in categories.
- **Category_Memory**: The set of Memory_Entries the server stores for one User.
- **Memory_Entry**: One mapping from a Note_Key to a category, created from a User correction, with its last-updated time.
- **Category_History**: The categories of the User's own saved expenses from the preceding 90 days, grouped by Note_Key.
- **Entry_Status_Row**: The row that shows one submitted entry's pending, saved, failed, removing, or undone state.
- **Undo_Window**: The 8 seconds after an entry is confirmed during which its Undo control is offered.
- **Entry_Answer**: The immediate, server-calculated answer shown after a confirmed save.
- **Remaining_Spendable**: Spendable_Budget minus confirmed Expense_Data assigned to Needs_Budget or Wants_Budget for the applicable month. It is negative when the budget is exceeded.
- **Days_Remaining_Inclusive**: The number of calendar days remaining in the Current_Month, including Today.
- **Recurring_Auto_Post**: An expense that the existing recurring-expense logic creates by itself once a month when the due day of an active recurring definition arrives.
- **Allowance_Exclusion**: An explicit mark on one expense. The User sets or clears it, and the system sets it on a Recurring_Auto_Post when the expense is created, as Requirement 18 defines. It is stored as a nullable column of the expense record, is shown in text wherever the expense is listed, and means that the expense is not counted against the daily allowance. It changes only Today_Spent, Left_Today, and Allowance_Progress, as Requirement 18 defines. An expense without the mark is counted.
- **Counted_Expense**: A confirmed expense whose spending date is Today and that has no Allowance_Exclusion.
- **Today_Spent**: The sum, in integer paise, of the amounts of Counted_Expenses. An expense that has an Allowance_Exclusion is never part of Today_Spent.
- **Allowance_Basis**: Remaining_Spendable plus Today_Spent. It is the Spendable_Budget not yet used by any expense other than the Counted_Expenses, so an expense dated Today that has an Allowance_Exclusion reduces it exactly as an expense dated on another day of the Current_Month does.
- **Today_Allowance**: The greater of zero and Allowance_Basis divided by Days_Remaining_Inclusive, rounded to the nearest paise with half-paise rounded upward. When Today_Spent is zero and the Daily_Spending_Guide is not negative, Today_Allowance equals the Daily_Spending_Guide.
- **Left_Today**: Today_Allowance minus Today_Spent. A negative value means Today_Spent is over Today_Allowance.
- **Active_Bill**: A bill of the Current_Month's plan that is active and whose effective period includes the Current_Month, exactly as the existing monthly plan applies bills.
- **Bill_Match**: The condition that the Note_Key of an entry equals the normalized label of an Active_Bill, or contains that label as a whole word or phrase when the label has at least 3 characters. The label is normalized in the same way as a Note_Key.
- **Large_Entry_Threshold**: The greater of 25 percent of the Current_Month's Spendable_Budget, rounded to the nearest paise with half-paise rounded upward, and ₹1,000.00. The server calculates it, and it is absent when the Current_Month has no Spendable_Budget above zero.
- **Large_Entry**: An entry dated Today whose amount is at least the Large_Entry_Threshold.
- **Entry_Warning**: The text shown in the Entry_Preview before submission when a Parsed_Entry dated Today is a Large_Entry or has a Bill_Match, together with the two explicit save choices that Requirement 18 defines.
- **Allowance_Calculator**: The canonical server-side calculation of Today_Spent, Today_Allowance, and Left_Today.
- **Home_Headline**: The Home outcome that reads "You can spend ₹X today", where X is Today_Allowance, with Left_Today shown beside X under the label "left today", together with Today_Spent and Allowance_Progress.
- **Allowance_Progress**: A visual indicator and text label of Today_Spent against Today_Allowance. The server calculates the percentage as a whole number of tenths of a percent.
- **Expense_API**: The existing authenticated operations that create, update, and delete Expense_Data under the clarity contract.
- **Memory_API**: The authenticated operations introduced by this feature that list, create or replace, and delete Memory_Entries and that return the User's category hints.

## Requirements

### Requirement 1: Reach Quick Add from Every Signed-in Page

**User Story:** As a User who logs spending by typing, I want to start an entry from wherever I am, so that recording an expense takes seconds.

#### Acceptance Criteria

1. WHILE Quick_Add_Enabled and the User views Home, THE Quick_Add SHALL place Quick_Add_Input directly below the Home_Headline and above the existing quick-action tiles.
2. WHILE Quick_Add_Enabled and the bottom tab bar is displayed, THE Quick_Add SHALL show a Floating_Action of at least 48 by 48 CSS pixels on every signed-in page of the User view.
3. WHILE the bottom tab bar is displayed, THE Floating_Action SHALL remain clear of the bottom tab bar, the device safe area, and the toast area.
4. WHEN the User activates the Floating_Action on Home, THE Quick_Add SHALL move keyboard focus to the Quick_Add_Input on Home.
5. WHEN the User activates the Floating_Action on a page other than Home, THE Quick_Add SHALL open the Quick_Add_Input in a dialog over the current page without navigating away.
6. WHILE Quick_Add_Enabled, THE Quick_Add SHALL provide the Quick_Add_Shortcut on every signed-in page of the User view at every viewport width.
7. THE Quick_Add_Shortcut SHALL be Cmd + K on Apple platforms and Ctrl + K on every other platform, and SHALL NOT respond to the other platform's modifier.
8. WHILE the bottom tab bar is not displayed and the User views Home, THE Quick_Add SHALL show the Quick_Add_Shortcut key combination as visible text beside Quick_Add_Input, and THE Quick_Add dialog SHALL show the same text.
9. WHEN the User activates the Quick_Add_Shortcut while focus is in another text field, THE Quick_Add SHALL move focus to the Quick_Add_Input and leave the value of the other field unchanged.
10. WHEN the User closes the Quick_Add dialog, THE Quick_Add SHALL return keyboard focus to the control or element that had focus before the dialog opened.
11. WHEN the User closes the Quick_Add dialog while an entry is pending, THE Quick_Add SHALL continue saving the entry and keep its Entry_Status_Row available when the dialog reopens.
12. WHILE an entry has failed and no Quick_Add surface is open, THE Quick_Add SHALL show a nonblocking text status stating the number of entries not saved, with an action that opens Quick_Add.
13. WHILE the Data_Use_Gate pauses new financial inputs, THE Quick_Add SHALL keep Quick_Add_Input editable, SHALL keep Entry_Preview available, SHALL disable submission, and SHALL show the Data_Use_Gate reason.
14. THE Quick_Add SHALL expose the Quick_Add_Shortcut to assistive technology through the `aria-keyshortcuts` property of every control that opens or focuses Quick_Add.
15. WHEN the User presses the Quick_Add_Shortcut, THE Quick_Add SHALL cancel the browser's default action for that key combination only when the press opens or focuses Quick_Add.
16. THE Quick_Add SHALL ignore a Quick_Add_Shortcut press while an input method composition is in progress, while Shift or Alt is also held, while the key is held down in repeat, and while another modal dialog or the Data_Use_Gate notice is open.
17. WHEN the User presses the Quick_Add_Shortcut while the Quick_Add dialog is open, THE Quick_Add SHALL move focus to Quick_Add_Input and SHALL NOT close the dialog or open a second one.
18. WHILE Quick_Add_Enabled is false or no User is signed in, THE Quick_Add SHALL leave the key combination to the browser and the operating system.
19. THE Quick_Add SHALL NOT appear on the administrator console pages.

### Requirement 2: Parse a Typed Entry into Amount, Note, and Date

**User Story:** As a User, I want to type an entry the way I would say it, so that I do not have to fill separate fields.

#### Acceptance Criteria

1. THE Quick_Add_Parser SHALL produce its Parse_Result from the Quick_Add_Line and Today alone, without reading the network, storage, the clock, the locale, or the device time zone.
2. THE Quick_Add_Parser SHALL return a Parse_Result for every Quick_Add_Line without throwing an error, within time linear in the length of the line.
3. IF the Quick_Add_Line exceeds 200 characters, counted in UTF-16 code units as the input's maximum length counts them, THEN THE Quick_Add_Parser SHALL return a Parse_Problem that states the length and the 200-character limit.
4. WHEN the Quick_Add_Parser reads a Quick_Add_Line, THE Quick_Add_Parser SHALL split the line into tokens at whitespace and SHALL classify each token by its Unicode NFKC form while keeping the original text of the token for Note_Text.
5. WHEN a token consists only of digits or of digits with a single decimal point, optionally with comma grouping, THE Quick_Add_Parser SHALL treat the token as an amount candidate.
6. WHEN a token mixes digits with letters, such as `7up`, `route66`, or `3pm`, THE Quick_Add_Parser SHALL treat the token as Note_Text.
7. WHEN an amount candidate uses comma grouping, THE Quick_Add_Parser SHALL accept the grouping only if every group follows the Indian pattern of one final group of three digits and earlier groups of two digits, or every group follows the pattern of groups of three digits.
8. WHEN an amount candidate has a fractional part of one or two digits, THE Quick_Add_Parser SHALL interpret one digit as tenths of a rupee, so that `120.5` is 12,050 paise.
9. WHEN an amount candidate is preceded by a Currency_Marker or followed by `/-`, THE Quick_Add_Parser SHALL treat the marker and the suffix as part of the Amount_Token.
10. IF an amount candidate has more than two fractional digits, inconsistent comma grouping, or no digit before the decimal point, THEN THE Quick_Add_Parser SHALL return an invalid-amount Parse_Problem that names the token and SHALL NOT round or truncate the value.
11. IF an amount candidate equals zero or has more than 11 digits before the decimal point, THEN THE Quick_Add_Parser SHALL return an invalid-amount Parse_Problem that states the accepted range of ₹0.01 to ₹99,99,99,99,999.99.
12. WHEN exactly one amount candidate remains after Date_Tokens are removed, THE Quick_Add_Parser SHALL use that candidate as the Amount_Token.
13. WHEN more than one amount candidate remains and exactly one carries a Currency_Marker, THE Quick_Add_Parser SHALL use the marked candidate as the Amount_Token and keep the other candidates in Note_Text.
14. IF more than one amount candidate remains and none or more than one carries a Currency_Marker, THEN THE Quick_Add_Parser SHALL return a multiple-amounts Parse_Problem that lists the candidates and asks the User to mark the amount with `₹`.
15. IF no amount candidate remains, THEN THE Quick_Add_Parser SHALL return a missing-amount Parse_Problem.
16. WHEN a token is `today` or `yesterday`, THE Quick_Add_Parser SHALL set the date to Today or to the day before Today, matching the word without regard to letter case.
17. WHEN a token is a full weekday name, THE Quick_Add_Parser SHALL set the date to the most recent date on or before Today that falls on that weekday.
18. WHEN the line contains `on` followed by an integer from 1 through 31, with or without an ordinal suffix, or contains an ordinal from 1st through 31st, THE Quick_Add_Parser SHALL set the date to the most recent date on or before Today whose day of the month is that integer.
19. WHEN the line contains `on` followed by an integer greater than 31, THE Quick_Add_Parser SHALL treat the integer as an amount candidate and `on` as Note_Text.
20. WHEN a token has the form `dd/mm`, THE Quick_Add_Parser SHALL read the day first and set the date to the most recent date on or before Today with that day and month.
21. WHEN a token has the form `dd/mm/yy`, `dd/mm/yyyy`, or `yyyy-mm-dd`, THE Quick_Add_Parser SHALL set the date to exactly that date, reading a two-digit year as 20yy.
22. IF a Date_Token does not name a real calendar date, such as `31/02` or `0th`, THEN THE Quick_Add_Parser SHALL return an invalid-date Parse_Problem that names the token.
23. IF the date is outside the Accepted_Date_Range, THEN THE Quick_Add_Parser SHALL return an invalid-date Parse_Problem that states the Accepted_Date_Range.
24. IF the line contains more than one Date_Token, THEN THE Quick_Add_Parser SHALL return a multiple-dates Parse_Problem that lists the tokens.
25. WHEN the line contains no Date_Token, THE Quick_Add_Parser SHALL set the date to Today.
26. WHEN text is enclosed in double quotes, THE Quick_Add_Parser SHALL treat the enclosed text as Note_Text without interpreting any amount or date in it.
27. WHEN a double quote appears twice in a row inside quoted text, THE Quick_Add_Parser SHALL read the pair as one literal double quote.
28. IF a double quote has no closing quote, THEN THE Quick_Add_Parser SHALL treat the quote character as ordinary Note_Text.
29. IF the Note_Text exceeds 120 characters, counted in UTF-16 code units as the Expense_API counts them, THEN THE Quick_Add_Parser SHALL return a Parse_Problem that states the length and the 120-character limit.
30. IF the Quick_Add_Line has more than one problem, THEN THE Quick_Add_Parser SHALL return every Parse_Problem so the User can correct them together.
31. THE Quick_Add_Parser SHALL treat only the ASCII digits 0 through 9, after NFKC normalization of the token, as digits, so that Devanagari, Telugu, and other script numerals remain Note_Text.
32. THE Quick_Add_Formatter SHALL convert a Parsed_Entry into a Quick_Add_Line containing a Currency_Marker, the amount with Indian digit grouping and two fractional digits when the amount has paise, the date as `yyyy-mm-dd`, and the Note_Text enclosed in double quotes when the Note_Text is not empty.
33. FOR ALL Parsed_Entry values with a canonical Note_Text, parsing the output of the Quick_Add_Formatter SHALL produce an equivalent Parsed_Entry (round-trip property).
34. THE Quick_Add_Parser SHALL keep a Note_Text written in any script, including Hindi and Telugu, exactly as typed.
35. THE Quick_Add_Parser SHALL recognize Currency_Markers, `today`, `yesterday`, weekday names, `on`, and ordinal suffixes in English with ASCII letters only.

### Requirement 3: Show What Was Understood and Refuse to Guess

**User Story:** As a User, I want to see exactly what the app understood before an entry is saved, so that a typing slip does not become a wrong record.

#### Acceptance Criteria

1. WHILE the Quick_Add_Line is not empty, THE Quick_Add SHALL show the Entry_Preview within 100 milliseconds of each change to the line.
2. THE Entry_Preview SHALL show the amount with the rupee sign and Indian digit grouping, the category with its reason, the date as weekday, day, month, and year, and the Note_Text or the text "No note".
3. WHEN the line has no Date_Token, THE Entry_Preview SHALL label the date as "Today".
4. WHEN the date is after Today, THE Entry_Preview SHALL label the date as "Future date".
5. WHEN the date falls in a month other than the Current_Month, THE Entry_Preview SHALL state the month and year the entry counts toward.
6. WHILE the Parse_Result contains Parse_Problems, THE Entry_Preview SHALL show a neutral text status that the line is not ready to save and SHALL NOT announce the status to assistive technology.
7. WHEN the User submits a Quick_Add_Line whose Parse_Result contains Parse_Problems, THE Quick_Add SHALL send no request.
8. WHEN the User submits a Quick_Add_Line whose Parse_Result contains Parse_Problems, THE Quick_Add SHALL show each Parse_Problem as text that names the affected part, the reason, and the accepted correction.
9. WHEN the User submits a Quick_Add_Line whose Parse_Result contains Parse_Problems, THE Quick_Add SHALL associate each text error with Quick_Add_Input for assistive technology and announce the errors without moving keyboard focus.
10. WHEN the User submits a Quick_Add_Line whose Parse_Result contains Parse_Problems, THE Quick_Add SHALL keep the typed line unchanged.
11. THE Quick_Add SHALL save an amount only when the amount equals the paise value of exactly one Amount_Token in the Quick_Add_Line.
12. WHILE the Quick_Add_Line is empty, THE Quick_Add SHALL take no action when the User presses Enter.
13. WHEN the Parse_Result is a Parsed_Entry with an empty Note_Text, THE Quick_Add SHALL allow the save, SHALL show "No note" for the note, and SHALL show the category as "Other" with the text label "Default".
14. WHEN the Note_Text contains the whole word `monthly`, `weekly`, `yearly`, or `recurring`, or the phrase `every month`, THE Entry_Preview SHALL show the text "Quick Add saves one expense. To repeat a payment every month, add it as a bill in Plan." and SHALL NOT block the save.

### Requirement 4: Validate with the Same Rules as the Expense Form

**User Story:** As a User, I want a quick entry to be held to the same rules as a form entry, so that quick entries never create records the rest of the app cannot handle.

#### Acceptance Criteria

1. THE Quick_Add SHALL accept only an amount above zero with at most 11 digits before the decimal point and at most two fractional digits, matching the existing expense form.
2. THE Quick_Add SHALL accept only a real calendar date inside the Accepted_Date_Range.
3. THE Quick_Add SHALL accept only a Note_Text of at most 120 characters.
4. THE Quick_Add SHALL accept only a category that is a built-in category or a custom category the User has created.
5. THE Quick_Add SHALL send the Expense_API only the structured amount in paise, category, Note_Text, and date, and SHALL NOT send the Quick_Add_Line.
6. THE Expense_API SHALL validate every field of a Quick_Add save with the same validation as every other expense creation, independent of the client's parsing.
7. IF the Expense_API rejects a Quick_Add save for validation, THEN THE Quick_Add SHALL show a message that names the affected field and the accepted constraint on the entry's Entry_Status_Row.
8. IF the Expense_API rejects a Quick_Add save for validation, THEN THE Quick_Add SHALL offer an action to edit the entry and SHALL NOT offer a retry with the same Idempotency-Key.

### Requirement 5: Suggest a Category and Explain Why

**User Story:** As a User, I want the app to pick a sensible category and tell me why, so that I rarely have to choose one myself.

#### Acceptance Criteria

1. WHEN the Parse_Result is a Parsed_Entry, THE Category_Suggester SHALL produce exactly one Category_Suggestion.
2. IF the Parsed_Entry's Note_Key matches a Memory_Entry whose category is available to the User, THEN THE Category_Suggester SHALL suggest that category with the source memory.
3. IF no Memory_Entry applies and the Parsed_Entry's Note_Key matches the Note_Key of one or more expenses in the Category_History, THEN THE Category_Suggester SHALL suggest the category of the most recent of those expenses, if the category is available to the User, with the source history.
4. IF neither memory nor history applies and a whole word of the Note_Text equals the name of a category available to the User without regard to letter case, THEN THE Category_Suggester SHALL suggest that category with the source category_name.
5. IF no earlier source applies and the Note_Text contains a whole word or whole phrase from the Keyword_Rules, THEN THE Category_Suggester SHALL suggest the mapped category with the source keyword.
6. WHEN more than one keyword rule matches, THE Category_Suggester SHALL choose the rule with the longest phrase, and SHALL choose the rule that appears first in the Keyword_Rules when phrase lengths are equal.
7. IF no source applies, THEN THE Category_Suggester SHALL suggest the Default_Category with the source default.
8. WHEN the Note_Text is empty, THE Category_Suggester SHALL suggest the Default_Category with the source default and a reason stating that there is no note to suggest from.
9. THE Category_Suggester SHALL suggest only a category that is currently available to the User.
10. THE Category_Suggester SHALL give the same Category_Suggestion for the same inputs, using no randomness, no network request, and no external service.
11. THE Category_Suggestion SHALL include a reason, built from a fixed template, that names the source and the matched note, word, or category.
12. WHEN the source is default, THE Entry_Preview SHALL label the category as "Default" in text.
13. THE Keyword_Rules SHALL map only to built-in categories.
14. WHILE the User's remembered choices and history are still loading, THE Entry_Preview SHALL state that saved choices are being checked.
15. IF the User's remembered choices and history cannot be loaded, THEN THE Entry_Preview SHALL state that saved choices are unavailable and THE Category_Suggester SHALL use the remaining sources.
16. THE Category_Suggester SHALL use the memory and history sources only when the Note_Key equals a stored Note_Key exactly, so that `coffee` and `coffee with priya` stay separate and no keyword or similarity matching applies to those two sources.
17. THE Keyword_Rules SHALL contain English words and phrases in ASCII letters only, and WHEN a Note_Text is written in Hindi, Telugu, or another script, THE Category_Suggester SHALL use the memory, history, and category_name sources and then the Default_Category.

### Requirement 6: Correct a Category in One Action and Remember It

**User Story:** As a User, I want to fix a wrong category once and have the app remember it, so that the same note is right next time.

#### Acceptance Criteria

1. WHEN the User activates the category control in the Entry_Preview, THE Quick_Add SHALL list every category available to the User and let the User choose one with a single selection by keyboard, mouse, or touch.
2. WHEN the User chooses a category for an entry before saving, THE Quick_Add SHALL save the entry with the chosen category.
3. WHEN the User chooses a category on a saved Entry_Status_Row, THE Quick_Add SHALL change the expense's category through the Expense_API update operation with Scoped_Feedback on that row.
4. WHEN a category change on a saved Entry_Status_Row is confirmed, THE Entry_Answer SHALL update from the confirmed server values.
5. WHEN the User saves or changes an entry with a non-empty Note_Key to a category different from the Category_Suggester's suggestion, THE Memory_API SHALL create or replace the Memory_Entry for that Note_Key with the chosen category.
6. THE Memory_API SHALL keep at most one Memory_Entry for each Note_Key for each User.
7. THE Memory_API SHALL keep at most 500 Memory_Entries for each User and SHALL replace the least recently updated Memory_Entry when a new Memory_Entry would exceed the limit.
8. IF the Memory_API fails after an expense is saved, THEN THE Quick_Add SHALL keep the saved expense and show a message on the Entry_Status_Row that the choice was not remembered, with a retry action.
9. THE Memory_API SHALL store Category_Memory on the server and SHALL make each Memory_Entry readable and changeable only by the User who owns the entry.
10. THE Settings page SHALL list each Memory_Entry with its note and category and SHALL provide an action to delete one Memory_Entry and an action to delete all Memory_Entries.
11. WHEN the User deletes a Memory_Entry, THE Category_Suggester SHALL stop using that entry for suggestions from the next suggestion on.
12. WHEN the source of the Category_Suggestion is memory, THE Entry_Preview SHALL offer a "Forget this" action that deletes that Memory_Entry.
13. WHEN the User deletes a custom category, THE Memory_API SHALL delete every Memory_Entry that maps to that category.
14. THE Category_Memory SHALL be used only to suggest categories in Quick_Add.
15. WHEN the User requests a data export, THE Financial_Clarity_Experience SHALL include every Memory_Entry of the User with a plain-language description of the table.
16. WHEN the User completes account deletion, THE Financial_Clarity_Experience SHALL delete every Memory_Entry of the User as part of the existing account-deletion scope.
17. IF account deletion cannot delete the User's Memory_Entries, THEN THE Financial_Clarity_Experience SHALL report category memory as an undeleted record category through the existing incomplete-deletion path.
18. WHEN this feature introduces Category_Memory, THE Data_Use_Notice SHALL identify the data category, the purpose of suggesting categories, the roles that can access it, the absence of sharing, the retention until deletion, and the correction, export, and deletion controls before the new use begins.
19. THE Memory_API SHALL store and match Note_Keys written in any script exactly as the Note_Key definition normalizes them.

### Requirement 7: Save with One Enter Through the Existing Expense Path

**User Story:** As a User, I want one Enter or tap to save an entry safely, so that a slow network or a double press never loses or duplicates an expense.

#### Acceptance Criteria

1. WHEN the User presses Enter or activates the save control with a Parsed_Entry and financial inputs enabled, THE Quick_Add SHALL create the expense through the Expense_API create operation with a new Idempotency-Key and the `X-Clarity-Contract` header.
2. WHEN the User submits an entry, THE Quick_Add SHALL show an Entry_Status_Row with a pending status, the amount, the category, the date, and the Note_Text within 100 milliseconds.
3. WHEN the User submits an entry, THE Quick_Add SHALL clear Quick_Add_Input and keep keyboard focus in Quick_Add_Input for the next entry.
4. WHILE an entry is pending, THE Quick_Add SHALL keep unrelated page content visible and unrelated controls interactive.
5. WHEN an entry is saved, THE Quick_Add SHALL complete the save without a page reload and without a page-wide loading state.
6. WHEN the Expense_API confirms an entry, THE Entry_Status_Row SHALL show a saved status and THE Quick_Add SHALL show the Entry_Answer within 100 milliseconds of the response.
7. IF an entry request fails because the device is offline, the request times out, the server returns an error, or the server returns a rate-limit response, THEN THE Quick_Add SHALL mark the Entry_Status_Row as failed and keep the entry's values.
8. WHEN an entry is marked failed, THE Entry_Status_Row SHALL offer a retry action that resends the same request with the same Idempotency-Key, an edit action, and a discard action.
9. WHEN a retry with the same Idempotency-Key succeeds, THE Expense_API SHALL hold exactly one expense for that entry.
10. WHEN the User chooses the edit action and Quick_Add_Input is empty, THE Quick_Add SHALL place the output of the Quick_Add_Formatter in Quick_Add_Input and use a new Idempotency-Key on the next submission.
11. WHEN the User chooses the discard action, THE Quick_Add SHALL remove the Entry_Status_Row and leave every confirmed record unchanged.
12. WHILE five entries are pending, THE Quick_Add SHALL disable submission, keep the typed line, and state in text that earlier entries are still saving.
13. IF an entry remains pending for more than 5 seconds, THEN THE Quick_Add SHALL state that the free server may be waking up and SHALL keep the entry pending without resending it.
14. WHEN the User submits several entries in quick succession, THE Quick_Add SHALL give each entry its own Idempotency-Key and its own Entry_Status_Row.
15. WHEN several entries are pending, THE Expense_API SHALL save each entry exactly once regardless of the order in which responses arrive.
16. IF the server answers that the Data_Use_Notice must be reviewed, THEN THE Quick_Add SHALL keep the entry, show the Data_Use_Gate reason, and offer a retry after the notice is reviewed.
17. WHEN an entry is confirmed, THE Financial_Clarity_Experience SHALL show the expense in every mounted view of the affected month's Expense_Data without a page reload.
18. THE Quick_Add SHALL keep drafts, pending entries, and failed entries in memory only and SHALL NOT write them to local storage, session storage, cookies, or the address.
19. WHEN the User signs out, THE Quick_Add SHALL discard every draft, Entry_Status_Row, Memory_Entry copy, and category hint held in the browser.
20. THE Quick_Add SHALL send at most one expense write request per entry and at most one Memory_API write request per entry, and SHALL NOT poll the server.
21. THE Financial_Clarity_Experience SHALL treat an expense created by Quick_Add exactly like an expense created by the Spending form in every existing view, export, monthly review, and logging streak.
22. THE Quick_Add SHALL create exactly one expense for each entry and SHALL NOT create, change, or activate a recurring expense or a bill.
23. IF the Expense_API or the Memory_API gives no response within 60 seconds of a request, THEN THE Quick_Add SHALL treat the request as timed out and mark the entry as failed with the same-key retry available.

### Requirement 8: Undo a Save for a Few Seconds

**User Story:** As a User, I want to take back an entry I just typed wrongly, so that I can fix a slip without opening the Spending page.

#### Acceptance Criteria

1. WHEN an entry is confirmed, THE Entry_Status_Row SHALL offer an Undo control for the Undo_Window and SHALL state in static text that Undo is available for 8 seconds.
2. WHEN the User activates Undo, THE Quick_Add SHALL delete that entry's expense through the Expense_API delete operation with a new Idempotency-Key.
3. WHEN the User activates Undo, THE Entry_Status_Row SHALL show a removing status within 100 milliseconds.
4. THE Undo control SHALL delete exactly the expense that the entry created and SHALL NOT delete any other expense, including another expense with the same amount, note, and date.
5. WHEN the Expense_API confirms the deletion, THE Entry_Status_Row SHALL show an undone status and THE Entry_Answer SHALL show the server's values after the deletion.
6. WHEN the Expense_API confirms the deletion and the entry had created or replaced a Memory_Entry, THE Quick_Add SHALL restore the Memory_Entry for that Note_Key to the category it had before the entry was saved, or remove it if there was none, unless that Memory_Entry was changed after the entry was saved, in which case THE Memory_API SHALL leave the newer change in place. A Memory_Entry that the 500-entry limit removed when the entry was saved is not restored.
7. WHEN the Expense_API confirms the deletion, THE Quick_Add SHALL return keyboard focus to Quick_Add_Input unless the User has moved focus to another control.
8. IF the deletion request fails, THEN THE Entry_Status_Row SHALL keep the expense as saved, show an undo-failed message, and offer a retry with the same Idempotency-Key.
9. WHILE an undo request is pending or has failed, THE Undo control SHALL remain available beyond the Undo_Window.
10. WHILE the Undo control has keyboard focus or the pointer is over the Undo control, THE Quick_Add SHALL pause the Undo_Window.
11. WHEN the Undo_Window ends, THE Quick_Add SHALL remove the Undo control and keep the expense, and the expense SHALL remain deletable through the existing Spending page.
12. IF the expense no longer exists when the User activates Undo, THEN THE Quick_Add SHALL show that the entry was already removed and SHALL refresh the Entry_Answer.
13. WHEN the User changes the category of an entry during the Undo_Window, THE Undo control SHALL still delete the expense of that entry.
14. THE Undo control's accessible name SHALL include the entry's amount and Note_Text.

### Requirement 9: Give an Immediate Answer After Each Saved Entry

**User Story:** As a User, I want to see what each entry means for today and for my budget the moment it is saved, so that logging changes what I do next.

#### Acceptance Criteria

1. WHEN an entry is confirmed, THE Entry_Answer SHALL use only the integer-paise values in the snapshot that the Expense_API response carries.
2. WHEN an entry is confirmed, THE Quick_Add SHALL NOT add, subtract, multiply, or divide any money value in the browser.
3. WHEN a confirmed entry is dated in the Current_Month, THE Entry_Answer SHALL show Today_Spent, Today_Allowance, and Left_Today.
4. WHEN a confirmed entry is dated in the Current_Month, THE Entry_Answer SHALL state the entry's date when the date is not Today.
5. WHEN a confirmed entry is dated in the Current_Month and Left_Today is negative, THE Entry_Answer SHALL show the amount over Today_Allowance in text such as "Over today's allowance by ₹X".
6. WHEN a confirmed entry is dated in a month other than the Current_Month, THE Entry_Answer SHALL name that month, SHALL show Remaining_Spendable and the bucket status for that month, and SHALL state that the entry counts toward that month and not toward the Current_Month.
7. WHEN a confirmed entry is dated in a month other than the Current_Month, THE Quick_Add SHALL leave the Home_Headline for the Current_Month unchanged.
8. WHEN an entry is confirmed, THE Entry_Answer SHALL state whether the entry's category counts toward Needs_Budget or Wants_Budget, using the treatment the server applied.
9. WHEN an entry is confirmed, THE Entry_Answer SHALL show the spent amount and the budget of that Needs_Budget or Wants_Budget for the entry's month.
10. IF the Needs_Budget or Wants_Budget of the entry's month is exceeded, THEN THE Entry_Answer SHALL show "{Needs or Wants} budget exceeded by ₹X" using the excess amount the server provides.
11. IF Remaining_Spendable of the entry's month is negative, THEN THE Entry_Answer SHALL show the amount over the month's spendable budget in text.
12. IF Salary_Data or the monthly plan inputs for the entry's month are missing, THEN THE Entry_Answer SHALL confirm that the expense was saved, name the month and the minimum missing input, and link to the existing Plan pay form.
13. IF an input of the entry's monthly plan is invalid, THEN THE Entry_Answer SHALL confirm that the expense was saved and name the invalid input, the accepted constraint, and the affected outcome.
14. IF the effect of a confirmed entry cannot be calculated, THEN THE Entry_Answer SHALL confirm that the expense was saved, mark the effect as temporarily unavailable, and provide one retry action that recalculates without resubmitting the entry.
15. WHEN a newer confirmed snapshot arrives from a later save, correction, or undo, THE Quick_Add SHALL replace the values in the current Entry_Answer and SHALL NOT replace a newer snapshot with an older one.
16. WHEN several entries are confirmed, THE Quick_Add SHALL show the Entry_Answer of the most recently confirmed entry as the current answer and keep a one-line status on each earlier Entry_Status_Row.
17. THE Entry_Answer SHALL label each value as a calculated result and SHALL provide the existing explanation control for Today_Allowance.
18. WHEN an entry is confirmed, THE Quick_Add SHALL announce one concise polite message that states the amount, the category, and either Left_Today or the month the entry counts toward.
19. WHEN a confirmed entry dated Today was saved with an Allowance_Exclusion, THE Entry_Answer SHALL state in text that the entry is not counted against today's allowance, SHALL state that the month's totals include it, and SHALL show Today_Allowance after the save with a sentence that the allowance changed because the entry uses part of the month's budget.
20. WHEN a confirmed entry dated Today has no Allowance_Exclusion and was a Large_Entry, had a Bill_Match, or left Left_Today negative, THE Entry_Answer SHALL offer an action that changes the entry to not counted against today's allowance through the Expense_API update operation.

### Requirement 10: Calculate Today's Allowance on the Server

**User Story:** As a User, I want one trustworthy "what I can spend today" number, so that the app, the answer after each entry, and the Home headline never disagree.

#### Acceptance Criteria

1. THE Allowance_Calculator SHALL calculate Today_Spent as the sum, in integer paise, of the amounts of Counted_Expenses.
2. WHEN an expense has no recorded spending date, THE Allowance_Calculator SHALL attribute the expense to the Asia/Kolkata calendar date on which the expense was created.
3. THE Allowance_Calculator SHALL calculate Allowance_Basis as Remaining_Spendable plus Today_Spent.
4. THE Allowance_Calculator SHALL calculate Today_Allowance as the greater of zero and Allowance_Basis divided by Days_Remaining_Inclusive, rounded to the nearest paise with half-paise rounded upward.
5. THE Allowance_Calculator SHALL calculate Left_Today as Today_Allowance minus Today_Spent.
6. THE Allowance_Calculator SHALL use the same Spendable_Budget, expense treatment, integer-paise arithmetic, and rounding rules as the existing Daily_Spending_Guide.
7. WHEN Today_Spent is zero and the Daily_Spending_Guide is not negative, THE Allowance_Calculator SHALL set Today_Allowance equal to the Daily_Spending_Guide.
8. WHEN a Counted_Expense is created, updated, or deleted, THE Allowance_Calculator SHALL leave Today_Allowance unchanged and SHALL change Left_Today by exactly the change in Today_Spent with the opposite sign.
9. WHEN an expense that is not a Counted_Expense and is dated in the Current_Month, including an expense dated Today that has an Allowance_Exclusion, is created, updated, or deleted, THE Allowance_Calculator SHALL recalculate Today_Allowance from the changed Remaining_Spendable and SHALL leave Today_Spent unchanged.
10. WHEN an expense dated in another month is created, updated, or deleted, THE Allowance_Calculator SHALL leave Today_Spent, Today_Allowance, and Left_Today for the Current_Month unchanged.
11. IF Allowance_Basis is negative, THEN THE Allowance_Calculator SHALL set Today_Allowance to zero and SHALL report that the month's spendable budget was already used before Today, with the amount used beyond the budget.
12. IF Spendable_Budget is zero because bills equal or exceed the salary, THEN THE Allowance_Calculator SHALL set Today_Allowance to zero and report that the bills use all of the pay.
13. WHEN Today is the last day of the Current_Month, THE Allowance_Calculator SHALL use a Days_Remaining_Inclusive of 1.
14. WHEN Today is the first day of the Current_Month, THE Allowance_Calculator SHALL use a Days_Remaining_Inclusive equal to the number of days in the Current_Month.
15. THE Allowance_Calculator SHALL change the calendar day at local midnight in Asia/Kolkata regardless of the server or device time zone.
16. WHEN the requested month is not the Current_Month, THE Allowance_Calculator SHALL report Today_Spent, Today_Allowance, and Left_Today as not applicable.
17. THE Allowance_Calculator SHALL add Today_Spent, Today_Allowance, and Left_Today to the existing clarity snapshot as optional fields without changing the meaning of any existing field.
18. WHEN the User requests a Calculation_Explanation for Today_Allowance, THE Calculation_Explanation SHALL list in order the Spendable_Budget, the expenses used, Remaining_Spendable, the addition of Today_Spent, the division by Days_Remaining_Inclusive, the rounding, the floor at zero, and the subtraction of Today_Spent.
19. WHEN the User requests a Calculation_Explanation for Today_Allowance, THE Calculation_Explanation SHALL state in plain language how Today_Allowance differs from the Daily_Spending_Guide.
20. WHEN the Allowance_Exclusion of an expense is set or cleared, THE Allowance_Calculator SHALL leave Remaining_Spendable, Needs_Budget and Wants_Budget spending, category totals, total spending, Projected_Savings, and the Daily_Spending_Guide unchanged.
21. THE Allowance_Calculator SHALL give an expense dated Today that has an Allowance_Exclusion exactly the effect on Today_Allowance that an otherwise identical expense dated on another day of the Current_Month has.
22. THE Allowance_Calculator SHALL report the number and the total amount of the expenses dated Today that have an Allowance_Exclusion.
23. THE Allowance_Calculator SHALL report the Large_Entry_Threshold, and SHALL report it as absent when the Current_Month has no Spendable_Budget above zero.
24. THE Allowance_Calculator SHALL report Allowance_Progress as a whole number of tenths of a percent from 0 through 1000, calculated with integer arithmetic and rounded half-up, and SHALL report it as absent when Today_Allowance is zero.
25. WHEN the Calculation_Explanation for Today_Allowance lists expenses, THE Calculation_Explanation SHALL list the Counted_Expenses and the expenses dated Today that have an Allowance_Exclusion separately.

### Requirement 11: Show "You Can Spend ₹X Today" as the First Home Outcome

**User Story:** As a returning User, I want one clear number at the top of Home, so that I know in a glance what I can spend today.

#### Acceptance Criteria

1. WHILE Quick_Add_Enabled, THE Home_Headline SHALL be the first Financial_Outcome on Home, placed after the page decision header and before the Quick_Add_Input.
2. WHEN Today_Allowance is available, THE Home_Headline SHALL show the text "You can spend ₹X today", where X is Today_Allowance formatted with Indian digit grouping.
3. WHEN Today_Allowance is available, THE Home_Headline SHALL show Left_Today directly beside X with the label "left today" or, when Today_Spent exceeds Today_Allowance, the amount over Today_Allowance, together with Today_Spent and Today's date.
4. WHEN Today_Allowance is available, THE Home_Headline SHALL show Allowance_Progress as a visual bar and a text label that states the share of Today_Allowance used, with the bar filled in proportion to Today_Spent over Today_Allowance up to 100 percent.
5. THE Allowance_Progress SHALL convey its meaning through the text label in addition to color.
6. WHEN Today_Spent exceeds Today_Allowance, THE Home_Headline SHALL show "Over today's allowance by ₹X" with the excess amount and SHALL fill Allowance_Progress to 100 percent.
7. WHEN Today_Allowance is zero, THE Home_Headline SHALL omit the percentage, SHALL show "You can spend ₹0 today", and SHALL show the reason reported by the Allowance_Calculator.
8. IF the monthly plan for the Current_Month lacks Salary_Data, THEN THE Home_Headline SHALL state that the pay for the Current_Month is needed to show what the User can spend today and SHALL link to the existing Plan pay form.
9. IF an input of the Current_Month's plan is invalid, THEN THE Home_Headline SHALL name the invalid input, the accepted constraint, and the affected outcome.
10. IF the calculation of Today_Allowance fails after all inputs are valid, THEN THE Home_Headline SHALL mark the outcome as temporarily unavailable, SHALL provide one retry action, and SHALL keep the confirmed inputs.
11. WHILE the Home_Headline region is loading, THE Financial_Clarity_Experience SHALL show a size-stable placeholder confined to that region while keeping navigation available.
12. IF the Home_Headline region fails to load, THEN THE Financial_Clarity_Experience SHALL show an error and a retry action inside that region and preserve every other loaded region.
13. WHEN a save, category change, or undo is confirmed, THE Home_Headline SHALL update to the new server values within 100 milliseconds of the response.
14. WHILE Home is visible and Today differs from the date the snapshot was calculated for, THE Home_Headline SHALL mark its values as stale and re-read the snapshot within 60 seconds.
15. WHEN Home becomes visible after being hidden, THE Home_Headline SHALL compare Today with the snapshot date and re-read the snapshot when the dates differ.
16. THE Home_Headline SHALL provide the explanation control "How this was calculated" and SHALL keep an open explanation open while the values update.
17. THE Home_Headline SHALL label Today_Allowance as a calculated result and Today_Spent as a calculated result of confirmed expenses.
18. WHEN the device's local date or month differs from Today in Asia/Kolkata, THE Home_Headline SHALL request and show the Current_Month and date of Asia/Kolkata.
19. THE Financial_Clarity_Experience SHALL keep the existing "Daily spending guide" outcome unchanged in meaning and value.
20. WHEN at least one expense dated Today has an Allowance_Exclusion, THE Home_Headline SHALL show in text the number and the total amount of those expenses with the words "not counted today".
21. THE Home SHALL take the Current_Month and Today from the Asia/Kolkata calendar, using the device clock corrected by the server time of the latest response, and SHALL use that month for every Home read.
22. WHILE the Rollout_Flag is on, THE Financial_Clarity_Experience SHALL derive the Current_Month used by Home, Plan, Spending, Goals, and Trips from the Asia/Kolkata calendar, using the device clock corrected by the server time of the latest response, so that every clarity page names the same month as the server.
23. WHILE the Rollout_Flag is off, THE Financial_Clarity_Experience SHALL keep deriving the month from the device clock exactly as before this feature.

### Requirement 12: Be Usable by Everyone on Every Supported Screen

**User Story:** As a User with any device or assistive technology, I want Quick Add and the headline to be fully usable, so that logging works for me as well as for anyone.

#### Acceptance Criteria

1. THE Quick_Add_Input SHALL have a visible text label and an accessible name, and SHALL describe the accepted forms, with examples, through an associated description.
2. THE Quick_Add SHALL expose the Entry_Preview as text associated with Quick_Add_Input and SHALL NOT announce Entry_Preview changes while the User types.
3. THE Quick_Add SHALL announce confirmed saves, confirmed undos, and errors once each and SHALL NOT announce pending states.
4. THE Quick_Add SHALL make every control reachable and operable by keyboard without a pointer, including typing, saving, choosing a category, Undo, retry, edit, discard, and closing the dialog.
5. WHEN the User navigates by keyboard, THE Quick_Add SHALL move focus in the visual reading order without trapping focus outside the Quick_Add dialog.
6. WHILE the Quick_Add dialog is open, THE Quick_Add SHALL contain keyboard focus in the dialog, close the dialog on Escape, and label the dialog for assistive technology.
7. THE Quick_Add SHALL size every control to at least 44 by 44 CSS pixels.
8. WHEN a Quick_Add or Home_Headline status uses color or an icon, THE Quick_Add SHALL provide adjacent text with the same meaning.
9. THE Quick_Add and THE Home_Headline SHALL meet the contrast ratios of Requirements 12.11 through 12.14 of the Financial Clarity Experience for text, components, status icons, and focus indicators.
10. WHILE reduced motion is enabled by the User's device settings, THE Quick_Add and THE Home_Headline SHALL replace animated movement with an immediate state change, and THE Undo_Window SHALL be shown only as static text.
11. WHILE the viewport width is from 320 through 3840 CSS pixels, THE Quick_Add and THE Home_Headline SHALL present all content and controls without horizontal scrolling, clipping, or overlap.
12. WHILE the text size is 200 percent of the default, THE Quick_Add and THE Home_Headline SHALL present all content and controls without horizontal scrolling, clipping, or overlap at a viewport width of 320 CSS pixels.
13. WHEN a Quick_Add or Home_Headline value changes, THE Quick_Add SHALL keep keyboard focus on the active control until the User moves focus.
14. THE Quick_Add SHALL render every Note_Text, category name, and reason as plain text.
15. THE Entry_Warning SHALL be text associated with Quick_Add_Input, SHALL NOT rely on color alone, SHALL NOT move keyboard focus, and SHALL present its two save choices as controls of at least 44 by 44 CSS pixels that the keyboard can reach.

### Requirement 13: Give Fast, Scoped Feedback

**User Story:** As a User, I want every action to respond immediately without the page jumping, so that Quick Add feels faster than a form.

#### Acceptance Criteria

1. THE Quick_Add_Input SHALL be interactive before the clarity snapshot and the category hints have loaded.
2. WHEN the User submits an entry, THE Quick_Add SHALL show pending feedback on the entry's Entry_Status_Row within 100 milliseconds.
3. WHEN the Expense_API responds successfully, THE Quick_Add SHALL update every affected Financial_Outcome and show completion within 100 milliseconds.
4. WHILE an entry, a category change, or an undo is pending, THE Quick_Add SHALL confine loading feedback to the affected Entry_Status_Row and the dependent outcomes.
5. WHEN several entries are pending, THE Quick_Add SHALL show a separate status for each entry.
6. IF an entry, a category change, or an undo fails, THEN THE Quick_Add SHALL restore the affected record and dependent outcomes to the last confirmed values and retain every unrelated entered or confirmed value.
7. THE Quick_Add SHALL request the category hints at most once for each signed-in page load and again only after a Memory_Entry changes.
8. WHERE Product_Analytics is enabled, THE Success_Measurement SHALL count each Quick_Add save, category change, and undo in the existing reload-rate and page-wide-loading-rate measurements, whose targets remain zero percent.

### Requirement 14: Keep Entries Private

**User Story:** As a User, I want what I type to stay private, so that I can log honestly without worrying where the text goes.

#### Acceptance Criteria

1. THE Quick_Add SHALL send amounts, notes, categories, and Note_Keys only to the Expense_API and the Memory_API.
2. THE Quick_Add SHALL parse and suggest categories on the device and SHALL NOT call any external, third-party, or artificial-intelligence service.
3. THE Quick_Add SHALL NOT write the Quick_Add_Line, amounts, notes, Note_Keys, or categories to the browser console, local storage, session storage, cookies, or the address.
4. THE server SHALL NOT write amounts, notes, Note_Keys, categories, or any Quick_Add_Line to logs, error reports, or monitoring records, and SHALL record only record identifiers and error codes.
5. THE Quick_Add SHALL NOT introduce any new Product_Analytics event.
6. WHERE Product_Analytics is enabled, THE Quick_Add SHALL report a confirmed save, category change, or undo only through the existing value-free financial-change event, and WHERE Product_Analytics is disabled, THE Quick_Add SHALL report nothing.
7. THE Category_Memory SHALL stay out of public trip links, administrator summaries, and every Product_Analytics record.
8. WHEN the User disables Product_Analytics, THE Quick_Add SHALL continue to work without any change in saves, answers, or the Home_Headline.

### Requirement 15: Secure the New Operations

**User Story:** As a User, I want my entries and remembered choices protected, so that nobody else can read or change them.

#### Acceptance Criteria

1. THE Memory_API SHALL require an authenticated session and SHALL apply the existing session and token revocation checks.
2. THE Memory_API SHALL expose no anonymous operation.
3. THE Memory_API SHALL read, create, replace, and delete only Memory_Entries that belong to the authenticated User.
4. IF a User requests deletion of a Memory_Entry that does not belong to that User or does not exist, THEN THE Memory_API SHALL respond as for a missing record without revealing whether the entry exists for another User.
5. THE Memory_API SHALL reject a Note_Key that is empty or longer than 60 characters after normalization.
6. THE Memory_API SHALL reject a category that is not a built-in category or a custom category of the authenticated User.
7. THE Memory_API SHALL reject a request body that contains an unknown property or exceeds 1 kilobyte.
8. THE Memory_API SHALL treat every received string as data and SHALL NOT interpret the string as a query, markup, or command.
9. THE Memory_API SHALL return an error response that contains no information about another User and no stack trace.
10. THE Memory_API SHALL apply the same request rate limits as the existing finance mutation operations.
11. IF the Memory_API or the Expense_API returns a rate-limit response, THEN THE Quick_Add SHALL mark the entry as failed and offer the same-key retry.
12. THE Quick_Add SHALL generate each Idempotency-Key with a cryptographically secure random source.
13. THE Memory_API SHALL require the current Data_Use_Notice to be reviewed before any write and SHALL leave reads and deletes available.
14. THE Memory_API SHALL NOT change the existing CORS allowlist, request-size limit, or authentication scheme.
15. THE Expense_API SHALL accept the Allowance_Exclusion only as a boolean and SHALL reject any other type with a validation error that names the field.

### Requirement 16: Roll Out Safely and Stay Compatible

**User Story:** As the product owner, I want to switch Quick Add off without losing anything, so that a problem in production can be rolled back in minutes.

#### Acceptance Criteria

1. WHILE Quick_Add_Enabled is false, THE Financial_Clarity_Experience SHALL render Home, navigation, Spending, and Settings exactly as before this feature, with no Home_Headline, no Quick_Add_Input, no Floating_Action, no Quick_Add_Shortcut, no Allowance_Exclusion text or control, and no category memory list, except that Requirement 11.22 applies to the Current_Month whenever the Rollout_Flag is on.
2. WHILE Quick_Add_Enabled is false, THE Financial_Clarity_Experience SHALL send no Quick_Add request, no Memory_API request, and no request that carries an Allowance_Exclusion.
3. WHEN Quick_Add_Enabled changes from true to false, THE Financial_Clarity_Experience SHALL remove the Quick_Add surfaces and the Home_Headline and SHALL retain every saved expense, every Allowance_Exclusion, and every Memory_Entry.
4. THE Financial_Clarity_Experience SHALL keep the request and response behavior of the existing expense create, update, and delete operations unchanged for existing clients.
5. THE Financial_Clarity_Experience SHALL add the new snapshot fields, the Memory_API, and the optional Allowance_Exclusion field of expense requests and responses as additive changes that existing clients ignore without error.
6. THE Financial_Clarity_Experience SHALL create the Category_Memory storage and the nullable Allowance_Exclusion column by additive, repeatable migrations that leave every existing table, column, and row unchanged and need no backfill.
7. IF the server lacks the new snapshot fields, THEN THE Home_Headline SHALL show the temporarily unavailable state and THE Quick_Add SHALL still save entries and show the monthly answer without the Today values.
8. IF the server lacks the Memory_API, THEN THE Quick_Add SHALL suggest categories from the keyword, category_name, and default sources and SHALL still save entries.
9. THE Financial_Clarity_Experience SHALL require no new background worker, scheduled job, paid service, or external network dependency for this feature.
10. THE Category_Memory SHALL add no more than 500 rows for each User, and THE category hints SHALL cover at most the preceding 90 days and at most 500 Note_Keys.
11. THE Financial_Clarity_Experience SHALL gate Quick_Add submissions by the Data_Use_Gate in the same way as the existing expense form.
12. WHILE the Rollout_Flag is off, THE Quick_Add_Flag SHALL have no effect.
13. THE Quick_Add_Flag SHALL be off by default, so that a deployment that sets neither flag behaves as it did before this feature.
14. WHEN Quick_Add_Enabled changes from true to false, THE Financial_Clarity_Experience SHALL leave monthly totals, the Daily_Spending_Guide, exports, the monthly review, and the logging streak unchanged, because each counts every saved expense, including an expense that has an Allowance_Exclusion.
15. WHEN Quick_Add_Enabled changes from false to true, THE Financial_Clarity_Experience SHALL show previously saved Memory_Entries and Allowance_Exclusions without a migration step.
16. THE Financial_Clarity_Experience SHALL read the Quick_Add_Flag when the application loads, SHALL apply a change at the next load, and SHALL discard without any record an entry whose request had not been sent when the application unloaded.
17. IF the Expense_API response to a create request that asked for an Allowance_Exclusion does not confirm it, THEN THE Quick_Add SHALL state in text that the expense was saved and counted against today, and SHALL offer the update action that sets the Allowance_Exclusion.
18. THE Quick_Add_Server_Flag SHALL be off by default, so that a deployment that sets neither flag keeps the Data_Use_Notice version it had before this feature.
19. WHILE the Quick_Add_Server_Flag is off, THE Memory_API SHALL refuse every write with a disabled answer, THE Quick_Add SHALL treat category memory as unavailable and keep saving entries, and THE Memory_API SHALL keep listing and deleting existing Memory_Entries.
20. WHEN the Quick_Add_Server_Flag is turned on, THE Financial_Clarity_Experience SHALL make the Category_Memory_Notice the current Data_Use_Notice and SHALL ask each User who has not reviewed it to acknowledge it once.
21. WHILE a User has not acknowledged the Category_Memory_Notice, THE Financial_Clarity_Experience SHALL pause new financial inputs through the Data_Use_Gate and SHALL keep reading, export, correction, and deletion of existing records available.
22. WHEN the Quick_Add_Server_Flag is turned off after Users acknowledged the Category_Memory_Notice, THE Financial_Clarity_Experience SHALL NOT ask any User to review the Data_Use_Notice again.

### Requirement 17: Make the Behavior Testable

**User Story:** As a developer, I want the parser and the allowance calculation to be pure and property-testable, so that mistakes in money handling are found by tests and not by Users.

#### Acceptance Criteria

1. THE Quick_Add_Parser, THE Quick_Add_Formatter, THE Category_Suggester, and THE Allowance_Calculator SHALL be pure functions whose results depend only on their arguments.
2. FOR ALL amounts in paise from 1 through the accepted maximum, formatting the amount with Indian digit grouping, with or without a Currency_Marker, and parsing the result SHALL produce the original amount in paise.
3. FOR ALL amounts, parsing the amount written with Indian grouping, with Western three-digit grouping, and with no grouping SHALL produce the same amount in paise.
4. FOR ALL Quick_Add_Lines, THE Quick_Add_Parser SHALL return a Parsed_Entry only when exactly one Amount_Token was consumed and every non-whitespace character of the line is accounted for in the Amount_Token, a Currency_Marker, a Date_Token, or the Note_Text.
5. FOR ALL Quick_Add_Lines that parse into a Parsed_Entry, reordering the Amount_Token, the Date_Token, and the Note_Text segments of the line SHALL produce an equivalent Parsed_Entry.
6. FOR ALL Quick_Add_Lines and all values of Today, a date resolved from `yesterday`, a weekday name, `on N`, an ordinal, or `dd/mm` SHALL be on or before Today and SHALL be the latest date that matches the token.
7. FOR ALL Quick_Add_Lines, a Parsed_Entry SHALL contain a real calendar date inside the Accepted_Date_Range and an amount in paise that is a positive safe integer.
8. FOR ALL Quick_Add_Lines, running the Quick_Add_Parser twice with the same Today SHALL produce equal Parse_Results, independent of the process time zone and locale.
9. FOR ALL combinations of Note_Text, Category_Memory, Category_History, available categories, and Keyword_Rules, THE Category_Suggester SHALL return a category from the available categories and SHALL follow the precedence of memory, history, category_name, keyword, and default.
10. FOR ALL sequences of corrections and deletions, THE Category_Memory SHALL hold at most one Memory_Entry for each Note_Key and no more than 500 Memory_Entries, and a Memory_Entry created for one User SHALL NOT change any suggestion for another User.
11. FOR ALL Parsed_Entries, saving the same entry with the same Idempotency-Key any number of times SHALL leave exactly one expense for that entry.
12. FOR ALL sets of entries with distinct Idempotency-Keys saved concurrently, the final ledger SHALL equal the starting ledger plus each entry exactly once, regardless of the order of responses.
13. FOR ALL ledgers and entries, including an entry saved with an Allowance_Exclusion, saving an entry and then undoing the entry SHALL restore the ledger, the Category_Memory, and the server's Remaining_Spendable, Today_Spent, Today_Allowance, and Left_Today to their values before the save.
14. FOR ALL ledgers, plans, and values of Today, Today_Allowance SHALL be at least zero, SHALL be unchanged by any Counted_Expense, and SHALL equal the Daily_Spending_Guide when Today_Spent is zero and the Daily_Spending_Guide is not negative.
15. FOR ALL ledgers and plans, Left_Today SHALL equal Today_Allowance minus Today_Spent, and a created Counted_Expense SHALL decrease Left_Today by exactly the expense's amount.
16. FOR ALL ledgers, THE Allowance_Calculator SHALL produce the same Today_Allowance as a simple reference implementation that sums the month's expenses day by day.
17. FOR ALL ledgers, an expense dated in another month SHALL NOT change Today_Spent, Today_Allowance, or Left_Today for the Current_Month.
18. THE test suite SHALL include example tests for a leap day, the last and first day of a month, the Asia/Kolkata midnight rollover, `31` in a 30-day month, a zero spendable budget, an overspent month, an expense with no spending date, an entry dated in a past month and in a future month, an entry saved with an Allowance_Exclusion and then undone, a Bill_Match, a Large_Entry whose amount equals the Large_Entry_Threshold, a Recurring_Auto_Post dated Today, and a note that equals an Active_Bill label of fewer than 3 characters.
19. THE test suite SHALL include a test that captures server logs during a Quick_Add save and fails if any amount, note, Note_Key, or category appears in the logs.
20. FOR ALL ledgers, plans, and values of Today, setting or clearing the Allowance_Exclusion of any expense SHALL leave Remaining_Spendable, Needs_Budget and Wants_Budget spending, category totals, total spending, Projected_Savings, and the Daily_Spending_Guide unchanged.
21. FOR ALL ledgers, plans, and values of Today, an expense dated Today that has an Allowance_Exclusion SHALL produce the same Today_Allowance as the identical expense dated on any other day of the Current_Month, and SHALL leave Today_Spent unchanged.
22. FOR ALL ledgers, plans, and values of Today, each expense of the Current_Month SHALL be exactly one of a Counted_Expense, an expense dated Today with an Allowance_Exclusion, or an expense dated on another day, and the amounts of the three groups SHALL sum to total spending.
23. FOR ALL Parsed_Entries, notes, Active_Bills, and Large_Entry_Thresholds, an Entry_Warning SHALL be shown exactly when the date is Today and the entry has a Bill_Match or is a Large_Entry, SHALL NOT depend on letter case, Unicode normalization form, or whitespace runs in the note or the label, and SHALL stay shown when the amount increases.
24. FOR ALL keyboard events, the Quick_Add_Shortcut matcher SHALL accept an event exactly when the platform's modifier is held with no other modifier, the key is K by its key value or its physical key code, the event is not a repeat, and no composition is in progress.
25. FOR ALL strings, the browser and server implementations of the Note_Key normalization SHALL return the same Note_Key, checked against one shared fixture file and against generated strings.
26. FOR ALL expenses, the Allowance_Exclusion in the JSON export and in the CSV export SHALL equal the stored Allowance_Exclusion.
27. FOR ALL active recurring definitions and dates, each Recurring_Auto_Post SHALL have the Allowance_Exclusion set and SHALL equal, in every other stored value, the expense that the recurring logic created before this feature, and a second run in the same month SHALL create no expense.
28. THE existing tests of recurring expenses SHALL keep their expectations about the amount, category, note, spending date, once-a-month posting, correction, and deletion of a Recurring_Auto_Post, and a test that compares a complete expense record SHALL change only by the one added Allowance_Exclusion value.

### Requirement 18: Handle Large and Bill-like Entries Without Distorting Today

**User Story:** As a User who sometimes types a rent payment or another large one-off expense, I want a clear warning and a one-tap choice that keeps it out of today's spending, so that one large entry does not make today's number meaningless while my month stays accurate.

#### Acceptance Criteria

1. WHEN the Parse_Result is a Parsed_Entry dated Today and the Note_Key has a Bill_Match, THE Entry_Preview SHALL show an Entry_Warning in text that states "This looks like a bill" and names the label of the matching Active_Bill.
2. WHEN the Parse_Result is a Parsed_Entry that is a Large_Entry, THE Entry_Preview SHALL show an Entry_Warning in text that states the amount is large compared with this month's spendable budget.
3. WHEN a Parsed_Entry has both a Bill_Match and a Large_Entry, THE Entry_Preview SHALL show one Entry_Warning that gives both reasons.
4. WHEN the Entry_Warning is caused by a Bill_Match, THE Entry_Warning SHALL state that the Plan already subtracts this bill, so that saving it as an expense also uses spendable budget.
5. WHILE an Entry_Warning is shown, THE Entry_Preview SHALL offer two save actions with visible text, "Save and count today" and "Save, but don't count against today".
6. WHEN the User presses Enter while an Entry_Warning is shown, THE Quick_Add SHALL save the entry as "Save and count today" does.
7. WHEN the User activates "Save, but don't count against today", THE Quick_Add SHALL create the expense with the Allowance_Exclusion in the same create request, exactly once, with the same pending, failed, retry, and undo behavior as any other entry.
8. WHEN the Parsed_Entry is not dated Today, THE Quick_Add SHALL show no Entry_Warning and SHALL offer no choice to exclude the entry.
9. THE Entry_Warning SHALL NOT block, delay, or change a save, and SHALL NOT change the amount, category, note, or date of the entry.
10. THE Quick_Add SHALL decide whether to show an Entry_Warning on the device from the Active_Bill labels and the Large_Entry_Threshold that the server provides, using integer comparison and no calculation of money in the browser.
11. IF the Active_Bill labels or the Large_Entry_Threshold are unavailable, THEN THE Quick_Add SHALL show no Entry_Warning for the unavailable cause and SHALL leave saving unaffected.
12. THE Allowance_Exclusion SHALL change only Today_Spent, Left_Today, and Allowance_Progress, and SHALL NOT change Remaining_Spendable, Needs_Budget or Wants_Budget spending, category totals, total spending, Projected_Savings, the Daily_Spending_Guide, the monthly review, the logging streak, or any export amount.
13. WHEN an expense dated Today has an Allowance_Exclusion, THE Allowance_Calculator SHALL reduce Remaining_Spendable by its amount as for any expense, so that Today_Allowance falls by the same amount as for an identical expense dated on another day.
14. THE Financial_Clarity_Experience SHALL store the Allowance_Exclusion as an additive, nullable integer column of the expense record, with an empty value meaning counted, and SHALL NOT store it as a hidden rule, a derived setting, or a property of the note, category, or amount.
15. THE Allowance_Exclusion SHALL be set or cleared only by an explicit User action, which is the save choice in this requirement, the action on an Entry_Status_Row, or the control in the Spending page edit form, and by the system only when a Recurring_Auto_Post is created, as criterion 23 defines.
16. WHILE Quick_Add_Enabled, THE Spending page SHALL show the text "Not counted in daily allowance" beside each expense that has an Allowance_Exclusion, including each Recurring_Auto_Post, and the edit form of an expense SHALL provide a labelled checkbox that sets or clears it with a note that it affects only the day the expense is dated.
17. WHEN the User sets or clears the Allowance_Exclusion of a saved expense, THE Quick_Add or the Spending page SHALL send it through the Expense_API update operation with an Idempotency-Key and the `X-Clarity-Contract` header, with Scoped_Feedback on that expense.
18. THE Expense_API SHALL return the Allowance_Exclusion as a boolean on every expense record of the clarity contract and in the month's expense list, and SHALL return false for an expense without the mark.
19. WHEN the User exports data as JSON, THE Financial_Clarity_Experience SHALL include the Allowance_Exclusion column of each expense.
20. WHEN the User exports expenses as CSV, THE Financial_Clarity_Experience SHALL append a final column `counted_in_daily_allowance` with the value `yes` or `no` for each expense and SHALL keep the existing columns and their order.
21. WHEN the User undoes an entry that was saved with an Allowance_Exclusion, THE Quick_Add SHALL delete the expense as Requirement 8 describes, and every server value SHALL return to its value before the save.
22. THE Allowance_Exclusion SHALL exist only as a column of the expense record, so that every existing export, deletion, and retention rule that applies to an expense applies to it.
23. WHEN the existing recurring logic creates a Recurring_Auto_Post, THE Financial_Clarity_Experience SHALL store the expense with the Allowance_Exclusion set in the same insert, so that the expense is not part of Today_Spent when it is dated Today and still counts in every monthly total, Needs or Wants bucket, category total, projection, export amount, monthly review, and logging streak.
24. WHEN the User clears the Allowance_Exclusion of a Recurring_Auto_Post, THE Financial_Clarity_Experience SHALL treat the expense as a Counted_Expense from then on, and a later correction of its amount, category, or note SHALL leave the Allowance_Exclusion unchanged.
25. THE Financial_Clarity_Experience SHALL keep the amount, category, note, spending date, once-a-month posting rule, and idempotence of every Recurring_Auto_Post exactly as before this feature, and SHALL set the Allowance_Exclusion on a Recurring_Auto_Post regardless of the Rollout_Flag, the Quick_Add_Flag, and the Quick_Add_Server_Flag, because the mark changes no amount, total, or projection.
26. THE Financial_Clarity_Experience SHALL define the Large_Entry percentage of 25, the Large_Entry floor of ₹1,000.00, and the minimum Bill_Match label length of 3 characters as named constants, each in exactly one source module of the runtime that uses it, and SHALL NOT repeat the literal values in any other source file.

## Out of Scope

- Reminders, email nudges, push notifications, an installable PWA, a weekly money story, shared budgets, and net worth.
- Importing entries from SMS, UPI, bank statements, or CSV files.
- Voice input, receipt photos, and optical character recognition.
- Natural-language dates beyond the tokens in Requirement 2, such as `tomorrow`, `last week`, `3 days ago`, month names, and weekday abbreviations.
- Amount shorthand such as `5k`, `2L`, or `1.5 lakh`, and amounts in currencies other than rupees.
- More than one expense in one Quick_Add_Line.
- Creating or editing recurring expenses, bills, salary, goals, trip expenses, or income through Quick_Add, including a Quick_Add_Line that asks for repetition.
- Editing an older expense through the Quick_Add_Input.
- An offline queue that survives a page reload, and persistence of drafts in browser storage.
- Machine-learning, large-language-model, or third-party categorization.
- Hindi, Telugu, or other local-language keyword rules and numerals. Note_Text in any script is saved as typed.
- New Product_Analytics events and administrator views of Category_Memory.
- Matching Category_Memory by keyword or similarity. Memory matches an exact Note_Key only.
- A per-User setting for the Large_Entry_Threshold, and automatic exclusion of an expense from Today_Spent by any rule other than the mark on a Recurring_Auto_Post in Requirement 18.
- Spreading a one-off expense over several days, and any change to the Daily_Spending_Guide.
- Changing the amount, category, note, spending date, or once-a-month schedule of a Recurring_Auto_Post, and any change to how recurring definitions are created or edited.
- Marking expenses that already exist, including Recurring_Auto_Posts created before this feature, because the migration backfills nothing.
- Customizable or additional keyboard shortcuts, and a separate switch for the Home_Headline alone.
- Changes to the existing Daily_Spending_Guide, the monthly review email, the logging streak calculation, or trip splitting.

## Owner Decisions

The owner approved nine decisions for the first draft and kept two decisions from it. The owner then approved six further decisions on the design. Each decision is integrated where the table says.

| # | Decision | Where it applies |
|---|---|---|
| 1 | Count every entry in the ledger. Warn when a Parsed_Entry dated Today matches an Active_Bill or is a Large_Entry, and offer one tap to save it without counting it against today. The mark is an explicit, visible, nullable column. | Glossary (Allowance_Exclusion, Bill_Match, Large_Entry), Requirements 9.19, 9.20, 10.1 and 10.8 through 10.25, 11.20, 16.6, 16.17, 17.20 through 17.23, 18 |
| 2 | The headline number is the steady Today_Allowance, with "left today" beside it. | Glossary (Home_Headline), Requirements 11.2, 11.3 |
| 3 | A day-only date resolves to the most recent such date on or before Today. | Requirements 2.17 through 2.20, 17.6 |
| 4 | Quick_Add never creates a recurring expense. | Requirements 3.14, 7.22, Out of Scope |
| 5 | An amount with no note is allowed, with category "Other" labelled "Default". | Requirements 3.13, 5.8, 5.12 |
| 6 | Category memory is per exact Note_Key. | Requirements 5.16, 6.5, 6.6, Out of Scope |
| 7 | Hindi and Telugu notes are saved as typed. Keyword rules and numerals are English and ASCII only. | Requirements 2.31, 2.34, 2.35, 5.17, 6.19 |
| 8 | A separate Quick_Add_Flag, off by default, effective only with the Rollout_Flag. | Glossary (Quick_Add_Flag, Quick_Add_Enabled), Requirement 16 |
| 9 | Ctrl or Cmd + K opens Quick_Add. The Undo_Window is 8 seconds. | Glossary (Quick_Add_Shortcut, Undo_Window), Requirements 1.6 through 1.19, 8.1 |
| Kept | Home shows the Home_Headline first and Quick_Add_Input directly below it, consistent with Requirement 12.1 of the Financial Clarity Experience. | Requirements 1.1, 11.1 |
| Kept | Today and the Home month use Asia/Kolkata. | Requirements 10.15, 11.18, 11.21 |
| 10 | Expenses that recurring definitions post automatically are marked with the Allowance_Exclusion when they are posted. They stay in every monthly total, bucket, and projection, and the User can clear the mark. | Glossary (Recurring_Auto_Post, Allowance_Exclusion), Requirements 17.18, 17.27, 17.28, 18.15, 18.16, 18.23 through 18.25, Out of Scope |
| 11 | A server flag turns the Category_Memory_Notice on. Existing Users acknowledge it once. Reading, export, correction, and deletion stay available while the gate is active. | Glossary (Quick_Add_Server_Flag, Category_Memory_Notice), Requirements 16.18 through 16.22 |
| 12 | The Large_Entry_Threshold is 25 percent of Spendable_Budget with a floor of ₹1,000.00. A Bill_Match is an equal note or a whole-word match of an Active_Bill label of at least 3 characters. The values are named constants in one module per runtime. | Glossary (Bill_Match, Large_Entry_Threshold), Requirements 17.18, 18.26 |
| 13 | One feature switch, with the client flag `VITE_QUICK_ADD_ENABLED` and the server flag `QUICK_ADD_ENABLED`, covers Quick Add and the Home_Headline together. | Glossary, Requirement 16 |
| 14 | The CSV export ends with the column `counted_in_daily_allowance`. | Requirement 18.20 |
| 15 | While the Rollout_Flag is on, the Current_Month on every clarity page comes from the Asia/Kolkata calendar. | Requirements 11.22, 11.23, 16.1 |
