# Requirements Document

## Introduction

Project Money currently provides monthly planning, expense tracking, savings goals, and trip splitting, but the product experience does not consistently explain how each requested input improves a user's financial decisions. The Financial Clarity Experience will make the product promise explicit: help each user understand what is safe to spend, what to save, and which action matters next.

This initiative covers the existing Home, Plan, Spending, Goals, and Trips experiences as one connected journey. It will connect salary, bill, expense, goal, and trip data to immediate and cumulative outcomes; explain how each outcome was derived; guide a new user to useful value before requesting optional detail; replace disruptive per-element loading with scoped feedback; preserve user control over financial data; and measure whether users understand and act on the resulting guidance.

The requirements describe user-visible behavior and product outcomes. They do not prescribe implementation architecture.

## Glossary

- **Financial_Clarity_Experience**: The cohesive Project Money experience spanning Home, Plan, Spending, Goals, and Trips that turns user-provided financial data into understandable outcomes and next actions.
- **User**: A signed-in Project Money account holder.
- **Core_Promise**: Project Money's commitment to show the User what is safe to spend, what to save, and which action matters next.
- **Guided_Journey**: The first-session flow that introduces the Core_Promise, lets the User choose a desired outcome, requests the minimum required data, and reveals useful results after each completed step.
- **Desired_Outcome**: The User-selected purpose for the session: plan the month, control spending, fund a goal, or settle a trip.
- **Purpose_Explanation**: A concise explanation shown before a data request that states why the data is requested, whether the data is required or optional, and which Financial_Outcome the data changes.
- **Input_Benefit_Preview**: A preview, using clearly identified example or existing values, of the Financial_Outcome that a requested input can unlock.
- **Salary_Data**: The User's take-home income for a specified month.
- **Bill_Data**: A recurring fixed obligation, such as rent, an EMI, insurance, a utility, or a subscription, that reduces the income available for allocation.
- **Expense_Data**: An amount spent by the User, including the spending date, category, and optional note.
- **Goal_Data**: A savings target containing a name, target amount, amount already saved, and target date.
- **Trip_Data**: A trip budget, member, shared expense, split, payment, or settlement record.
- **Current_Month**: The calendar month applicable to the User's current Project Money session in the configured local time zone.
- **Disposable_Income**: Salary_Data minus the total Bill_Data amount for the applicable month, with a minimum value of zero.
- **Needs_Budget**: Fifty percent of Disposable_Income allocated to essential spending.
- **Wants_Budget**: Thirty percent of Disposable_Income allocated to discretionary spending.
- **Savings_Target**: Twenty percent of Disposable_Income allocated to saving and investing.
- **Spendable_Budget**: The sum of Needs_Budget and Wants_Budget.
- **Daily_Spending_Guide**: The remaining Spendable_Budget divided by the number of calendar days remaining in the Current_Month, including the current day.
- **Projected_Savings**: Salary_Data minus Bill_Data and Expense_Data for the applicable month, with a minimum value of zero.
- **Financial_Outcome**: A calculated, user-visible result derived from one or more financial inputs, such as a budget, spending pace, savings projection, goal contribution, or trip balance.
- **First_Meaningful_Outcome**: The first personalized result that answers at least one Desired_Outcome and includes a value, an explanation, and a next action.
- **Monthly_Clarity_Summary**: A concise Home view showing current spending capacity, savings progress, and the highest-priority next action.
- **Actionable_Insight**: A recommendation that identifies the observed condition, the affected amount or deadline, one concrete action, and the expected effect of that action.
- **Calculation_Explanation**: An on-demand explanation that identifies source inputs, the calculation basis, category treatment, and the time period for a Financial_Outcome.
- **Goal_Funding_Gap**: The Goal_Data target amount minus the amount already saved, with a minimum value of zero.
- **Required_Goal_Contribution**: The Goal_Funding_Gap divided across the remaining monthly contribution opportunities before the target date.
- **Trip_Settlement**: The calculated amount each trip member owes or should receive based on Trip_Data.
- **Scoped_Feedback**: A pending, success, or error indication attached to the changed control, record, or directly affected outcome without replacing unrelated page content.
- **Financial_Record_Change**: The creation, update, or deletion of Salary_Data, Bill_Data, Expense_Data, Goal_Data, or Trip_Data.
- **Stale_Data**: Financial data whose applicable month or update time does not match the period represented by a Financial_Outcome.
- **Data_Use_Notice**: A plain-language statement of why financial data is used, who can access the data, which sharing settings apply, and which controls the User has.
- **Product_Analytics**: Nonessential measurement data used to evaluate the product experience without recording financial amounts, free-text notes, goal names, trip member identities, or trip names.
- **First_Meaningful_Outcome_Rate**: The percentage of new Users who start the Guided_Journey and reach a First_Meaningful_Outcome during the same session.
- **Time_To_First_Meaningful_Outcome**: The elapsed time between the start of the Guided_Journey and display of the First_Meaningful_Outcome.
- **Clarity_Confirmation_Rate**: The percentage of responding Users who affirm that Project Money has explained what the requested data provides.
- **Recommended_Action_Completion**: Completion of an in-product action directly linked from an Actionable_Insight, such as adding a bill, setting a category budget, recording a goal contribution, or recording a trip settlement.
- **Recommended_Action_Completion_Rate**: The percentage of Users who reach a First_Meaningful_Outcome and complete at least one Recommended_Action_Completion within seven calendar days.
- **Success_Measurement**: The product capability that calculates and reports adoption, clarity, responsiveness, and action metrics for the Financial_Clarity_Experience.

## Requirements

### Requirement 1: Make the Product Promise Explicit

**User Story:** As a new or returning User, I want to understand Project Money's purpose before entering financial data, so that I can decide whether the requested effort will help me.

#### Acceptance Criteria

1. THE Financial_Clarity_Experience SHALL communicate the Core_Promise before enabling the first financial input in each new session.
2. THE Financial_Clarity_Experience SHALL describe planning, spending, saving, and trip settlement as connected parts of the Core_Promise.
3. WHEN the User opens Home, THE Financial_Clarity_Experience SHALL name the decision as which current financial condition needs attention and name the action as the highest-ranked Actionable_Insight.
4. WHEN the User opens Plan, THE Financial_Clarity_Experience SHALL name the decision as how much income is available to spend and save and name the action as adding or correcting the applicable Salary_Data or Bill_Data.
5. WHEN the User opens Spending, THE Financial_Clarity_Experience SHALL name the decision as whether current spending fits the monthly plan and name the action as recording or correcting Expense_Data or addressing an exceeded budget.
6. WHEN the User opens Goals, THE Financial_Clarity_Experience SHALL name the decision as the contribution required for the selected goal and name the action as recording a contribution or adjusting Goal_Data.
7. WHEN the User opens Trips, THE Financial_Clarity_Experience SHALL name the decision as the User's amount owed, receivable, or settled and name the action as completing missing Trip_Data or recording a Trip_Settlement.
8. WHEN the available confirmed inputs are sufficient to calculate a personalized Financial_Outcome, THE Financial_Clarity_Experience SHALL present the personalized Financial_Outcome before any generic feature description or additional data request.
9. IF a personalized Financial_Outcome lacks a required input, THEN THE Financial_Clarity_Experience SHALL name the minimum missing input and the Financial_Outcome unlocked by the input.
10. IF a personalized Financial_Outcome contains an invalid input, THEN THE Financial_Clarity_Experience SHALL name the minimum invalid input, the accepted constraint, and the affected Financial_Outcome.
11. IF calculation of a personalized Financial_Outcome fails after all required inputs are confirmed as valid, THEN THE Financial_Clarity_Experience SHALL mark the Financial_Outcome as temporarily unavailable.
12. IF calculation of a personalized Financial_Outcome fails after all required inputs are confirmed as valid, THEN THE Financial_Clarity_Experience SHALL provide one calculation retry action.
13. IF calculation of a personalized Financial_Outcome fails after all required inputs are confirmed as valid, THEN THE Financial_Clarity_Experience SHALL retain the confirmed inputs without requesting duplicate entry.

### Requirement 2: Explain Every Data Request

**User Story:** As a User, I want each data request connected to a visible benefit, so that I understand why Project Money needs the information.

#### Acceptance Criteria

1. WHEN the Financial_Clarity_Experience requests Salary_Data, THE Purpose_Explanation SHALL name Disposable_Income, Needs_Budget, Wants_Budget, Savings_Target, Spendable_Budget, Daily_Spending_Guide, Projected_Savings, and goal feasibility as the affected Financial_Outcomes.
2. WHEN the Financial_Clarity_Experience requests Bill_Data, THE Purpose_Explanation SHALL name Disposable_Income, Needs_Budget, Wants_Budget, Savings_Target, Spendable_Budget, Daily_Spending_Guide, Projected_Savings, and goal feasibility as the affected Financial_Outcomes.
3. WHEN the Financial_Clarity_Experience requests Expense_Data, THE Purpose_Explanation SHALL name the applicable category total, remaining Spendable_Budget, Daily_Spending_Guide, and Projected_Savings as the affected Financial_Outcomes.
4. WHEN the Financial_Clarity_Experience requests Goal_Data, THE Purpose_Explanation SHALL name Goal_Funding_Gap, Required_Goal_Contribution, and feasibility against Savings_Target as the affected Financial_Outcomes.
5. WHEN the Financial_Clarity_Experience requests Trip_Data, THE Purpose_Explanation SHALL name each affected member balance and Trip_Settlement as the affected Financial_Outcomes.
6. WHEN the Financial_Clarity_Experience requests an input, THE Purpose_Explanation SHALL identify the input as required or optional before submission is enabled.
7. WHEN the User has an existing value for a requested input, THE Input_Benefit_Preview SHALL use the existing value to preview the named Financial_Outcome before submission.
8. IF the User has no existing value for a requested input, THEN THE Input_Benefit_Preview SHALL use a value visibly labeled as an example to preview the named Financial_Outcome before submission.
9. IF an optional input has no named Financial_Outcome, THEN THE Financial_Clarity_Experience SHALL omit the optional input request.
10. WHEN the Financial_Clarity_Experience requests an optional input, THE Financial_Clarity_Experience SHALL provide a skip action before submission.
11. WHEN the User skips an optional input, THE Financial_Clarity_Experience SHALL preserve every confirmed financial record and available Financial_Outcome.
12. WHEN the User skips an optional input, THE Financial_Clarity_Experience SHALL identify the named Financial_Outcome that remains unchanged or unavailable.

### Requirement 3: Guide the First Session to Useful Value

**User Story:** As a new User, I want a short, purposeful first-session journey, so that I reach useful financial guidance without completing a long setup process.

#### Acceptance Criteria

1. WHEN a new User starts the Guided_Journey, THE Guided_Journey SHALL offer exactly four Desired_Outcome choices: plan the month, control spending, fund a goal, and settle a trip.
2. WHEN the User selects a Desired_Outcome, THE Guided_Journey SHALL identify the minimum required data categories for the selected Desired_Outcome.
3. WHEN the User selects a Desired_Outcome, THE Guided_Journey SHALL require no more than three data categories before presenting a First_Meaningful_Outcome.
4. WHEN the User selects a Desired_Outcome, THE Guided_Journey SHALL require completion of no more than three required steps before presenting a First_Meaningful_Outcome.
5. WHEN the User provides the minimum valid inputs for the selected Desired_Outcome, THE Guided_Journey SHALL present a First_Meaningful_Outcome before requesting optional inputs.
6. WHEN a Guided_Journey step requests optional data, THE Guided_Journey SHALL provide a skip action and identify the Financial_Outcome available after skipping.
7. WHEN the User completes a Guided_Journey step, THE Guided_Journey SHALL show the newly unlocked Financial_Outcome and one next-step choice.
8. WHILE the User progresses through the Guided_Journey, THE Guided_Journey SHALL show the current step, completed required steps, and remaining required steps.
9. WHEN the User leaves the Guided_Journey before completion, THE Guided_Journey SHALL preserve every confirmed financial record and the next incomplete step.
10. WHEN the User returns to an incomplete Guided_Journey, THE Guided_Journey SHALL resume at the next incomplete step without requesting completed data again.
11. IF the User chooses settle a trip as the Desired_Outcome, THEN THE Guided_Journey SHALL allow the User to reach a Trip_Settlement without Salary_Data.
12. IF the User submits an invalid value during the Guided_Journey, THEN THE Guided_Journey SHALL identify the affected input and the accepted constraint beside the input.
13. IF the User submits an invalid value during the Guided_Journey, THEN THE Guided_Journey SHALL preserve every previously confirmed financial record.
14. IF a Guided_Journey save fails, THEN THE Guided_Journey SHALL identify the unconfirmed input and provide a retry action at the failed step.
15. IF a Guided_Journey save fails, THEN THE Guided_Journey SHALL preserve every previously confirmed financial record without creating a duplicate record.
16. WHEN a retried Guided_Journey save succeeds, THE Guided_Journey SHALL continue from the failed step without requesting previously confirmed inputs.

### Requirement 4: Turn Salary and Bills into a Clear Monthly Plan

**User Story:** As a User, I want salary and bills translated into a transparent monthly plan, so that I know what I can spend and save.

#### Acceptance Criteria

1. WHEN confirmed Salary_Data applies to a month, THE Financial_Clarity_Experience SHALL calculate Disposable_Income as the greater of zero and Salary_Data minus the sum of active Bill_Data amounts for the same month.
2. WHEN the confirmed Bill_Data set for an applicable month is empty, THE Financial_Clarity_Experience SHALL set Disposable_Income equal to Salary_Data for the same month.
3. WHEN total Bill_Data equals Salary_Data for an applicable month, THE Financial_Clarity_Experience SHALL set Disposable_Income, Needs_Budget, Wants_Budget, Savings_Target, and Spendable_Budget to zero for the same month.
4. IF total Bill_Data exceeds Salary_Data for an applicable month, THEN THE Financial_Clarity_Experience SHALL show a shortfall equal to total Bill_Data minus Salary_Data and set Disposable_Income to zero for the same month.
5. IF total Bill_Data equals or exceeds Salary_Data for an applicable month, THEN THE Financial_Clarity_Experience SHALL present one bill-review action.
6. WHEN Disposable_Income is greater than zero, THE Financial_Clarity_Experience SHALL calculate Needs_Budget as 50 percent, Wants_Budget as 30 percent, and Savings_Target as 20 percent of Disposable_Income.
7. WHEN the Financial_Clarity_Experience displays a 50/30/20 allocation, THE Financial_Clarity_Experience SHALL round each allocation to the nearest smallest displayed currency unit with half-unit values rounded upward.
8. IF rounded Needs_Budget, Wants_Budget, and Savings_Target do not sum to Disposable_Income, THEN THE Financial_Clarity_Experience SHALL apply the rounding difference to Savings_Target so the displayed allocations sum to Disposable_Income.
9. WHEN Needs_Budget and Wants_Budget are calculated, THE Financial_Clarity_Experience SHALL calculate Spendable_Budget as Needs_Budget plus Wants_Budget.
10. WHEN the Financial_Clarity_Experience calculates Daily_Spending_Guide for the Current_Month, THE Financial_Clarity_Experience SHALL divide Spendable_Budget minus confirmed Current_Month Expense_Data assigned to Needs_Budget or Wants_Budget by the number of calendar days remaining in the Current_Month, including the current day.
11. WHEN the Financial_Clarity_Experience displays Daily_Spending_Guide, THE Financial_Clarity_Experience SHALL round Daily_Spending_Guide to the nearest smallest displayed currency unit with half-unit values rounded upward.
12. WHEN the User confirms changed Salary_Data or Bill_Data, THE Financial_Clarity_Experience SHALL show the Disposable_Income difference between the newly confirmed values and the preceding confirmed values for the applicable month.
13. WHEN the User confirms changed Salary_Data or Bill_Data, THE Financial_Clarity_Experience SHALL show the Daily_Spending_Guide difference between the newly confirmed values and the preceding confirmed values for the applicable month.
14. WHEN a monthly plan Financial_Outcome is displayed, THE Financial_Clarity_Experience SHALL display the applicable month with the Financial_Outcome.
15. WHEN Salary_Data applies to a month other than the Current_Month, THE Financial_Clarity_Experience SHALL exclude Salary_Data from Current_Month Financial_Outcomes.
16. WHEN the User explicitly applies Salary_Data from another month to the Current_Month, THE Financial_Clarity_Experience SHALL recalculate Current_Month Financial_Outcomes and identify the Current_Month as the applicable month.
17. WHEN the User views a monthly plan Calculation_Explanation, THE Calculation_Explanation SHALL present the calculation order as Salary_Data, active same-month Bill_Data, Disposable_Income, 50/30/20 allocation, applicable Expense_Data, and Daily_Spending_Guide.

### Requirement 5: Turn Expenses into Spending Decisions

**User Story:** As a User, I want each expense to update practical spending guidance, so that daily tracking changes what I do next.

#### Acceptance Criteria

1. WHEN the Financial_Clarity_Experience calculates an expense category total, THE Financial_Clarity_Experience SHALL sum each confirmed Expense_Data amount matching the applicable month and category exactly once.
2. WHEN the User creates Expense_Data, THE Financial_Clarity_Experience SHALL add the confirmed amount once to the applicable category total and applicable month outcomes.
3. WHEN the User updates Expense_Data, THE Financial_Clarity_Experience SHALL remove the preceding confirmed amount from the original month and category before adding the newly confirmed amount to the resulting month and category.
4. WHEN the User deletes Expense_Data, THE Financial_Clarity_Experience SHALL remove the preceding confirmed amount once from the original month, category, and affected Financial_Outcomes.
5. WHEN an Expense_Data update changes the applicable month or category, THE Financial_Clarity_Experience SHALL recalculate Financial_Outcomes for both the original and resulting month or category.
6. WHEN the Financial_Clarity_Experience calculates remaining Spendable_Budget, THE Financial_Clarity_Experience SHALL subtract confirmed applicable Expense_Data assigned to Needs_Budget or Wants_Budget from Spendable_Budget.
7. WHEN confirmed Current_Month Expense_Data changes, THE Financial_Clarity_Experience SHALL calculate Daily_Spending_Guide as remaining Spendable_Budget divided by the calendar days remaining in the Current_Month, including the current day.
8. WHEN confirmed Current_Month Expense_Data changes, THE Financial_Clarity_Experience SHALL calculate Projected_Savings as the greater of zero and Salary_Data minus the sum of active Current_Month Bill_Data amounts minus the sum of confirmed Current_Month Expense_Data amounts.
9. IF confirmed spending assigned to Needs_Budget exceeds Needs_Budget, THEN THE Financial_Clarity_Experience SHALL identify Needs_Budget, the excess amount, and one corrective action that reduces or reclassifies the excess.
10. IF confirmed spending assigned to Wants_Budget exceeds Wants_Budget, THEN THE Financial_Clarity_Experience SHALL identify Wants_Budget, the excess amount, and one corrective action that reduces or reclassifies the excess.
11. WHEN the User changes the Needs_Budget or Wants_Budget treatment of an expense category, THE Financial_Clarity_Experience SHALL recalculate each affected Current_Month Financial_Outcome using the newly confirmed treatment.
12. WHEN Expense_Data applies to a month other than the Current_Month, THE Financial_Clarity_Experience SHALL exclude Expense_Data from Current_Month category totals, remaining Spendable_Budget, Daily_Spending_Guide, and Projected_Savings.
13. WHEN Expense_Data moves from the Current_Month to another month, THE Financial_Clarity_Experience SHALL remove the preceding confirmed amount once from every affected Current_Month Financial_Outcome.
14. WHEN Expense_Data moves from another month to the Current_Month, THE Financial_Clarity_Experience SHALL add the newly confirmed amount once to every affected Current_Month Financial_Outcome.

### Requirement 6: Turn Goals into Feasible Saving Actions

**User Story:** As a User, I want savings goals connected to my monthly capacity, so that I know what contribution is required and whether the deadline is realistic.

#### Acceptance Criteria

1. WHEN the User submits Goal_Data, THE Financial_Clarity_Experience SHALL accept a goal name containing at least one non-whitespace character.
2. WHEN the User submits Goal_Data, THE Financial_Clarity_Experience SHALL accept a target amount greater than zero.
3. WHEN the User submits Goal_Data, THE Financial_Clarity_Experience SHALL accept an amount already saved from zero through the target amount, inclusive.
4. WHEN the User creates Goal_Data or changes a target date, THE Financial_Clarity_Experience SHALL accept a valid calendar date on or after the current local calendar date.
5. IF submitted Goal_Data violates an accepted bound, THEN THE Financial_Clarity_Experience SHALL identify the affected field and accepted bound while retaining the preceding confirmed Goal_Data.
6. WHEN Goal_Data is valid, THE Financial_Clarity_Experience SHALL calculate Goal_Funding_Gap as the greater of zero and the target amount minus the amount already saved.
7. WHEN a valid target date is in the Current_Month or a future month, THE Financial_Clarity_Experience SHALL count monthly contribution opportunities from the Current_Month through the target month, including both months.
8. WHEN Goal_Funding_Gap is greater than zero and the target date is in the Current_Month or a future month, THE Financial_Clarity_Experience SHALL calculate Required_Goal_Contribution as Goal_Funding_Gap divided by the inclusive monthly contribution opportunities.
9. WHEN Required_Goal_Contribution contains a fraction of the smallest displayed currency unit, THE Financial_Clarity_Experience SHALL round Required_Goal_Contribution upward to the next smallest displayed currency unit.
10. WHEN Goal_Funding_Gap equals zero, THE Financial_Clarity_Experience SHALL set Required_Goal_Contribution to zero and identify the goal as funded.
11. WHEN Goal_Funding_Gap is greater than zero and the User records a goal contribution, THE Financial_Clarity_Experience SHALL accept an amount greater than zero and no greater than Goal_Funding_Gap.
12. IF a goal contribution is outside the accepted bounds, THEN THE Financial_Clarity_Experience SHALL retain the preceding confirmed Goal_Data and identify the accepted contribution range.
13. WHEN the User confirms a valid goal contribution, THE Financial_Clarity_Experience SHALL update the amount already saved, Goal_Funding_Gap, and Required_Goal_Contribution from the confirmed contribution exactly once.
14. WHEN Required_Goal_Contribution and Savings_Target are available, THE Financial_Clarity_Experience SHALL classify the goal as feasible when Required_Goal_Contribution is less than or equal to Savings_Target.
15. WHEN a goal is feasible, THE Financial_Clarity_Experience SHALL show Savings_Target minus Required_Goal_Contribution as the remaining monthly savings capacity.
16. IF Required_Goal_Contribution exceeds Savings_Target, THEN THE Financial_Clarity_Experience SHALL show the difference between Required_Goal_Contribution and Savings_Target.
17. IF Required_Goal_Contribution exceeds Savings_Target, THEN THE Financial_Clarity_Experience SHALL present one revised target amount or target date that makes Required_Goal_Contribution less than or equal to Savings_Target.
18. IF Salary_Data or the applicable monthly plan inputs are unavailable, THEN THE Financial_Clarity_Experience SHALL mark goal feasibility as unavailable and name the missing monthly plan input.
19. IF a target date passes before Goal_Funding_Gap reaches zero, THEN THE Financial_Clarity_Experience SHALL identify the goal as overdue and show Goal_Funding_Gap.
20. IF a target date passes before Goal_Funding_Gap reaches zero, THEN THE Financial_Clarity_Experience SHALL set Required_Goal_Contribution to unavailable and request a revised target amount or target date.

### Requirement 7: Turn Trip Data into Explainable Shared-Money Outcomes

**User Story:** As a User, I want trip records translated into fair balances and clear settlements, so that shared spending does not create confusion in my personal finances.

#### Acceptance Criteria

1. WHEN complete and valid Trip_Data exists for a shared expense, THE Financial_Clarity_Experience SHALL allocate the full expense amount across the included trip members according to the confirmed split rule.
2. WHEN the Financial_Clarity_Experience calculates a member balance, THE Financial_Clarity_Experience SHALL subtract the member's allocated expense shares and settlement payments received from the member's shared expense payments and settlement payments made.
3. WHEN the Financial_Clarity_Experience rounds an allocated expense share, THE Financial_Clarity_Experience SHALL round the share to the nearest smallest displayed currency unit with half-unit values rounded upward.
4. IF rounded allocated shares do not sum to the shared expense amount, THEN THE Financial_Clarity_Experience SHALL add or subtract one smallest displayed currency unit at a time in confirmed member order until the displayed shares sum to the shared expense amount.
5. WHEN the Financial_Clarity_Experience calculates all member balances for valid Trip_Data, THE Financial_Clarity_Experience SHALL produce displayed member balances that sum to zero.
6. WHEN valid Trip_Data changes, THE Financial_Clarity_Experience SHALL recalculate each affected member balance and Trip_Settlement from the newly confirmed Trip_Data.
7. WHEN the User's member balance is greater than zero, THE Financial_Clarity_Experience SHALL label the balance as receivable and show the balance amount.
8. WHEN the User's member balance is less than zero, THE Financial_Clarity_Experience SHALL label the absolute balance amount as owed.
9. WHEN the User's member balance equals zero, THE Financial_Clarity_Experience SHALL label the trip balance as settled.
10. WHEN valid unsettled member balances exist, THE Financial_Clarity_Experience SHALL calculate Trip_Settlement transfers that reduce every displayed member balance to zero.
11. WHEN the User views a Trip_Settlement, THE Calculation_Explanation SHALL identify every included shared expense, payer, allocated member share, split rule, settlement payment, and rounding adjustment.
12. WHEN Trip_Data could also qualify as Expense_Data, THE Financial_Clarity_Experience SHALL keep the shared trip balance separate from monthly Expense_Data Financial_Outcomes until the User confirms inclusion.
13. WHEN the User explicitly confirms inclusion of a personal trip payment in monthly Expense_Data, THE Financial_Clarity_Experience SHALL include the confirmed payment exactly once in the applicable month and category outcomes.
14. WHEN the User withdraws confirmed inclusion of a personal trip payment from monthly Expense_Data, THE Financial_Clarity_Experience SHALL remove the previously included payment exactly once from the applicable month and category outcomes.
15. WHERE public trip sharing is available, THE Financial_Clarity_Experience SHALL disclose every Trip_Data field visible through the public link before enabling public sharing.
16. IF a split rule or required member share is invalid or incomplete, THEN THE Financial_Clarity_Experience SHALL withhold new member balances and Trip_Settlement calculations.
17. IF a split rule or required member share is invalid or incomplete, THEN THE Financial_Clarity_Experience SHALL retain the last confirmed member balances and label the missing or invalid Trip_Data.
18. IF no confirmed member balance exists for invalid or incomplete Trip_Data, THEN THE Financial_Clarity_Experience SHALL mark the affected member balances and Trip_Settlement as unavailable.

### Requirement 8: Produce a Unified Financial Clarity Summary

**User Story:** As a returning User, I want one concise view of my current position and next action, so that I do not have to interpret separate feature pages.

#### Acceptance Criteria

1. WHEN confirmed Current_Month Salary_Data and available Current_Month Bill_Data and Expense_Data sets exist, THE Monthly_Clarity_Summary SHALL show remaining Spendable_Budget calculated from the confirmed records, including confirmed empty sets.
2. WHEN confirmed Current_Month Salary_Data and available Current_Month Bill_Data and Expense_Data sets exist, THE Monthly_Clarity_Summary SHALL show Daily_Spending_Guide using the calendar days remaining in the Current_Month, including the current day.
3. WHEN confirmed Current_Month Salary_Data and available Current_Month Bill_Data and Expense_Data sets exist, THE Monthly_Clarity_Summary SHALL compare Projected_Savings with Savings_Target and show the difference.
4. WHEN active Goal_Data with Goal_Funding_Gap greater than zero exists, THE Monthly_Clarity_Summary SHALL identify one highest-urgency goal.
5. WHEN multiple active goals exist, THE Monthly_Clarity_Summary SHALL select the highest-urgency goal by overdue status, earliest target date, largest Goal_Funding_Gap, and alphabetical goal name in that order.
6. WHEN valid unsettled Trip_Data exists, THE Monthly_Clarity_Summary SHALL identify one nearest Trip_Settlement action for the User.
7. WHEN multiple unsettled trips exist, THE Monthly_Clarity_Summary SHALL select the nearest Trip_Settlement by largest absolute User balance, earliest recorded unsettled Trip_Data, and alphabetical trip name in that order.
8. THE Monthly_Clarity_Summary SHALL present no more than three Actionable_Insights at one time.
9. WHEN multiple Actionable_Insights exist, THE Monthly_Clarity_Summary SHALL rank Actionable_Insights by earliest applicable deadline, largest quantified shortfall, largest absolute Current_Month effect, and alphabetical action label in that order.
10. WHEN the User selects an Actionable_Insight, THE Financial_Clarity_Experience SHALL take the User to the existing page and record context required to complete the recommended action.
11. IF inputs for one Monthly_Clarity_Summary value are missing or invalid, THEN THE Monthly_Clarity_Summary SHALL preserve every unaffected available summary value.
12. IF inputs for a Monthly_Clarity_Summary value are missing, THEN THE Monthly_Clarity_Summary SHALL name the minimum missing input and the Financial_Outcome unlocked by the input.
13. IF inputs for a Monthly_Clarity_Summary value are invalid, THEN THE Monthly_Clarity_Summary SHALL name the invalid input, accepted constraint, and affected Financial_Outcome.
14. IF no Actionable_Insight condition applies to confirmed current data, THEN THE Monthly_Clarity_Summary SHALL state that no action is needed for the Current_Month.
15. WHEN the Monthly_Clarity_Summary compares an Actionable_Insight with a deadline to an Actionable_Insight without a deadline, THE Monthly_Clarity_Summary SHALL rank the Actionable_Insight with the deadline first.

### Requirement 9: Make Outcomes Explainable and Current

**User Story:** As a User, I want to understand and verify each result, so that I can trust Project Money's guidance.

#### Acceptance Criteria

1. WHEN the Financial_Clarity_Experience presents a Financial_Outcome, THE Financial_Clarity_Experience SHALL visibly label each displayed component as an entered fact, calculated result, or recommendation.
2. WHEN the User requests a Calculation_Explanation, THE Calculation_Explanation SHALL identify every source input category and confirmed source value used by the Financial_Outcome.
3. WHEN the User requests a Calculation_Explanation, THE Calculation_Explanation SHALL identify the month or date range represented by the Financial_Outcome.
4. WHEN the User requests a Calculation_Explanation, THE Calculation_Explanation SHALL present each calculation operation and intermediate result in calculation order.
5. WHEN the User requests a Calculation_Explanation, THE Calculation_Explanation SHALL identify the displayed currency precision, rounding direction, and rounding adjustment used by the Financial_Outcome.
6. WHEN Stale_Data contributes to a Financial_Outcome, THE Financial_Clarity_Experience SHALL label the affected Financial_Outcome with the stale period and provide a refresh action.
7. IF a required source value is missing or invalid, THEN THE Financial_Clarity_Experience SHALL mark only the dependent Financial_Outcome as unavailable and identify the corrective input.
8. WHEN the Financial_Clarity_Experience presents an Actionable_Insight, THE Financial_Clarity_Experience SHALL label the recommendation as informational guidance rather than a guaranteed financial result.
9. WHEN a refresh succeeds, THE Financial_Clarity_Experience SHALL replace the affected stale values with confirmed current values and remove the stale label.
10. WHEN a refresh succeeds while a Calculation_Explanation is open, THE Calculation_Explanation SHALL update every affected source value, intermediate result, and Financial_Outcome to the same confirmed version.
11. IF a refresh fails, THEN THE Financial_Clarity_Experience SHALL retain the last confirmed values, label the affected values with the failed refresh status, and provide a scoped retry action.
12. WHEN a confirmed Financial_Record_Change affects an open Calculation_Explanation, THE Calculation_Explanation SHALL update the affected source values, operations, intermediate results, and Financial_Outcome without closing the explanation.

### Requirement 10: Replace Disruptive Loading with Scoped Feedback

**User Story:** As a User, I want changes to feel immediate without losing page context, so that recording financial data remains fast and understandable.

#### Acceptance Criteria

1. WHEN the User submits a valid Financial_Record_Change, THE Scoped_Feedback SHALL display a pending acknowledgement beside the affected control or record within 100 milliseconds.
2. WHILE a Financial_Record_Change is pending, THE Financial_Clarity_Experience SHALL keep unrelated page content visible.
3. WHILE a Financial_Record_Change is pending, THE Financial_Clarity_Experience SHALL keep unrelated controls interactive.
4. WHILE a Financial_Record_Change is pending, THE Scoped_Feedback SHALL identify the affected control or record and the pending change.
5. WHILE a Financial_Record_Change for a record is pending, THE Financial_Clarity_Experience SHALL prevent another submission of the same record change.
6. WHEN a Financial_Record_Change receives a successful response, THE Financial_Clarity_Experience SHALL update every affected Financial_Outcome within 100 milliseconds.
7. WHEN a Financial_Record_Change receives a successful response, THE Scoped_Feedback SHALL display completion beside the affected control or record within 100 milliseconds.
8. WHEN a Financial_Record_Change receives a successful response, THE Financial_Clarity_Experience SHALL preserve the current page document and navigation context without a page reload.
9. WHILE a Financial_Record_Change is pending, THE Financial_Clarity_Experience SHALL confine loading feedback to the affected control, record, and dependent Financial_Outcomes.
10. WHEN multiple independent Financial_Record_Changes are pending, THE Scoped_Feedback SHALL display a separate pending, success, or error status for each change.
11. IF a Financial_Record_Change fails, THEN THE Financial_Clarity_Experience SHALL restore the affected record and dependent Financial_Outcomes to the last confirmed values.
12. IF a Financial_Record_Change fails, THEN THE Financial_Clarity_Experience SHALL retain every unrelated entered or confirmed value.
13. IF a Financial_Record_Change fails, THEN THE Scoped_Feedback SHALL present a retry action beside the affected control or record.
14. WHERE an initial page content region is pending, THE Financial_Clarity_Experience SHALL display a stable placeholder confined to the pending region while keeping page navigation available.
15. IF an initial page content region fails to load, THEN THE Financial_Clarity_Experience SHALL display an error and retry action inside the failed region while preserving every successfully loaded region.

### Requirement 11: Preserve User Trust and Data Control

**User Story:** As a User, I want transparent data practices and complete control over my records, so that I can use financial guidance without surrendering trust.

#### Acceptance Criteria

1. THE Financial_Clarity_Experience SHALL present a Data_Use_Notice before enabling submission of the first financial input.
2. THE Data_Use_Notice SHALL identify each collected financial data category, each named Financial_Outcome, every role that can access each category, sharing defaults, the retention period or deletion event, correction control, export control, deletion control, and Product_Analytics control.
3. WHEN the Financial_Clarity_Experience introduces a new use of confirmed financial data, THE Data_Use_Notice SHALL identify the affected data category, new purpose, affected Financial_Outcome, access scope, and sharing scope before the new use begins.
4. WHEN the Financial_Clarity_Experience requests data for a named Financial_Outcome, THE Financial_Clarity_Experience SHALL request only fields required to calculate, explain, or complete that Financial_Outcome.
5. WHEN the User reviews a financial record, THE Financial_Clarity_Experience SHALL provide a correction path that identifies validation errors and preserves the preceding confirmed value until the correction succeeds.
6. WHEN the User requests a data export, THE Financial_Clarity_Experience SHALL include confirmed Salary_Data, Bill_Data, Expense_Data, Goal_Data, Trip_Data, Financial_Record_Changes, public-sharing settings, Product_Analytics settings, and related records introduced by the Financial_Clarity_Experience.
7. IF a data export fails, THEN THE Financial_Clarity_Experience SHALL label the export as unsuccessful, preserve every financial record, and provide an export retry action.
8. WHEN the User completes account deletion, THE Financial_Clarity_Experience SHALL include confirmed financial records, derived Financial_Outcomes, public-sharing links, Financial_Clarity_Experience settings, and User-linked Success_Measurement records in the existing account-deletion scope.
9. IF account deletion cannot complete for every in-scope record, THEN THE Financial_Clarity_Experience SHALL label account deletion as incomplete, identify each undeleted record category, and provide the existing account-deletion retry or support path.
10. WHERE a public sharing option exists, THE Financial_Clarity_Experience SHALL keep public sharing disabled until the User completes a separate sharing confirmation after reviewing the disclosed public fields.
11. WHEN the User revokes public sharing, THE Financial_Clarity_Experience SHALL make the public link unavailable and retain the private Trip_Data.
12. WHERE Product_Analytics is enabled, THE Success_Measurement SHALL exclude financial amounts, user-entered names, free-text notes, and trip member identities from Product_Analytics.
13. WHERE Product_Analytics is available, THE Financial_Clarity_Experience SHALL provide an explicit control for enabling or disabling nonessential Product_Analytics.
14. WHEN the User disables nonessential Product_Analytics, THE Success_Measurement SHALL stop collecting subsequent nonessential Product_Analytics for the User.
15. WHEN the User disables nonessential Product_Analytics, THE Financial_Clarity_Experience SHALL preserve every personalized Financial_Outcome and financial record.

### Requirement 12: Preserve Visual Clarity and Inclusive Access

**User Story:** As a User on any supported device, I want the clarity experience to remain visually calm and accessible, so that I can understand financial outcomes without unnecessary effort.

#### Acceptance Criteria

1. THE Financial_Clarity_Experience SHALL preserve the existing warm color palette, typography, and rounded visual forms while ordering the Core_Promise before Financial_Outcomes and Financial_Outcomes before primary actions.
2. WHEN the Financial_Clarity_Experience uses color or an icon to communicate status, THE Financial_Clarity_Experience SHALL provide an adjacent text label with the same status meaning.
3. WHEN a Financial_Outcome changes, THE Financial_Clarity_Experience SHALL announce the changed outcome and value to assistive technology.
4. WHEN a Financial_Outcome changes, THE Financial_Clarity_Experience SHALL retain keyboard focus on the active control until the User moves focus.
5. THE Financial_Clarity_Experience SHALL make every input, choice, navigation control, skip action, explanation control, retry action, and completion action reachable and operable by keyboard without pointer input.
6. WHEN the User navigates by keyboard, THE Financial_Clarity_Experience SHALL move focus in the visual reading order without trapping focus in a component.
7. WHILE reduced motion is enabled by the User's device settings, THE Financial_Clarity_Experience SHALL replace nonessential animated movement with an immediate state change or static transition.
8. WHILE the viewport width is from 320 through 3840 CSS pixels, THE Financial_Clarity_Experience SHALL present the Core_Promise, Financial_Outcomes, and primary actions without horizontal scrolling in the page or a content region.
9. WHILE the viewport width is from 320 through 3840 CSS pixels, THE Financial_Clarity_Experience SHALL present text, controls, Financial_Outcomes, and primary actions without clipping or overlap.
10. THE Purpose_Explanation SHALL use plain language and define each financial term at the first point of use.
11. WHEN the Financial_Clarity_Experience presents normal text, THE Financial_Clarity_Experience SHALL provide a contrast ratio of at least 4.5 to 1 between the text and background.
12. WHEN the Financial_Clarity_Experience presents text at least 18 points or at least 14 points in bold, THE Financial_Clarity_Experience SHALL provide a contrast ratio of at least 3 to 1 between the text and background.
13. WHEN the Financial_Clarity_Experience presents a user-interface component, status icon, chart element, or keyboard focus indicator required for understanding or operation, THE Financial_Clarity_Experience SHALL provide a contrast ratio of at least 3 to 1 against adjacent colors.
14. WHEN an interactive element receives keyboard focus, THE Financial_Clarity_Experience SHALL display a visible focus indicator around or adjacent to the focused element.
15. IF submitted input is invalid, THEN THE Financial_Clarity_Experience SHALL present a text error that identifies the affected input, the validation reason, and the accepted correction.
16. IF submitted input is invalid, THEN THE Financial_Clarity_Experience SHALL associate the text error with the affected input for assistive technology and announce the error without moving keyboard focus.
17. IF submitted input is invalid, THEN THE Financial_Clarity_Experience SHALL preserve every valid value already entered by the User.

### Requirement 13: Measure Product Clarity and Action

**User Story:** As a product owner, I want measurable evidence that Users understand and act on Project Money's guidance, so that the initiative can be evaluated against its purpose.

#### Acceptance Criteria

1. THE Success_Measurement SHALL use the configured local time zone of the Financial_Clarity_Experience for cohort assignment, reporting periods, and seven-day action windows.
2. THE Success_Measurement SHALL define a weekly reporting period from local 00:00 Monday inclusive through local 00:00 the following Monday exclusive.
3. THE Success_Measurement SHALL define a 28-day reporting period as 28 consecutive local calendar dates from local 00:00 on the first date inclusive through local 00:00 after the report-end date exclusive.
4. THE Success_Measurement SHALL classify a User as a new User when no Guided_Journey start exists before the User's earliest Guided_Journey start.
5. WHEN a new User's earliest Guided_Journey start falls within a reporting period, THE Success_Measurement SHALL include the User once in the new-User cohort for that reporting period.
6. THE Success_Measurement SHALL calculate First_Meaningful_Outcome_Rate as 100 multiplied by the number of cohort Users who display a First_Meaningful_Outcome during the starting Guided_Journey session divided by the total number of Users in the cohort.
7. WHEN a cohort User displays a First_Meaningful_Outcome during the starting Guided_Journey session, THE Success_Measurement SHALL calculate Time_To_First_Meaningful_Outcome from the Guided_Journey start timestamp through the First_Meaningful_Outcome display timestamp.
8. WHEN an odd number of cohort Users have a Time_To_First_Meaningful_Outcome, THE Success_Measurement SHALL report the middle duration after sorting all included durations from shortest to longest.
9. WHEN an even number of cohort Users have a Time_To_First_Meaningful_Outcome, THE Success_Measurement SHALL report the arithmetic mean of the two middle durations after sorting all included durations from shortest to longest.
10. WHEN a User reaches a First_Meaningful_Outcome, THE Financial_Clarity_Experience SHALL offer one nonblocking clarity confirmation question with exactly three response choices: Yes, Partly, and No.
11. WHEN the Financial_Clarity_Experience offers the clarity confirmation question, THE Financial_Clarity_Experience SHALL provide a skip action that leaves the next recommended action enabled.
12. THE Success_Measurement SHALL calculate Clarity_Confirmation_Rate as 100 multiplied by the number of submitted Yes responses divided by the total submitted Yes, Partly, and No responses from cohort Users.
13. WHEN a cohort User displays a First_Meaningful_Outcome, THE Success_Measurement SHALL define the seven-day action window from the display timestamp inclusive through the same local time on the seventh following calendar date exclusive.
14. WHEN a cohort User completes an in-product action directly linked from an Actionable_Insight during the seven-day action window, THE Success_Measurement SHALL count one Recommended_Action_Completion for the User regardless of additional linked action completions during the window.
15. THE Success_Measurement SHALL calculate Recommended_Action_Completion_Rate as 100 multiplied by the number of cohort Users with a Recommended_Action_Completion divided by the number of cohort Users who displayed a First_Meaningful_Outcome during the starting Guided_Journey session.
16. THE Success_Measurement SHALL calculate the Financial_Record_Change reload rate as 100 multiplied by the number of valid Financial_Record_Changes that trigger a page reload divided by all valid Financial_Record_Changes submitted during the reporting period.
17. THE Success_Measurement SHALL calculate the Financial_Record_Change page-wide loading rate as 100 multiplied by the number of valid Financial_Record_Changes that trigger a page-wide loading state divided by all valid Financial_Record_Changes submitted during the reporting period.
18. WHEN the Success_Measurement displays a percentage, THE Success_Measurement SHALL calculate the percentage from the unrounded numerator and denominator before rounding the displayed value to one decimal place with values exactly halfway between two tenths rounded upward.
19. WHEN the Success_Measurement evaluates a percentage target, THE Success_Measurement SHALL use the unrounded percentage.
20. THE Success_Measurement SHALL report each metric with the numerator, denominator, percentage or duration, reporting-period start, reporting-period end, configured local time zone, population definition, generation timestamp, and data-source status.
21. WHEN a 28-day reporting period contains at least 100 new Users in the cohort, THE Success_Measurement SHALL apply a First_Meaningful_Outcome_Rate target of at least 75 percent.
22. WHEN a 28-day reporting period contains at least 100 cohort Users with a Time_To_First_Meaningful_Outcome, THE Success_Measurement SHALL apply a median Time_To_First_Meaningful_Outcome target of no more than 120 seconds.
23. WHEN a 28-day reporting period contains at least 50 submitted clarity confirmation responses from cohort Users, THE Success_Measurement SHALL apply a Clarity_Confirmation_Rate target of at least 80 percent.
24. WHEN a 28-day reporting period contains at least 100 cohort Users who displayed a First_Meaningful_Outcome during the starting Guided_Journey session, THE Success_Measurement SHALL apply a Recommended_Action_Completion_Rate target of at least 40 percent.
25. WHEN a reporting period contains at least one valid Financial_Record_Change, THE Success_Measurement SHALL apply a Financial_Record_Change reload-rate target of zero percent.
26. WHEN a reporting period contains at least one valid Financial_Record_Change, THE Success_Measurement SHALL apply a Financial_Record_Change page-wide-loading-rate target of zero percent.
27. WHEN a metric meets the applicable minimum sample size and target, THE Success_Measurement SHALL classify the target as met.
28. WHEN a metric meets the applicable minimum sample size and misses the target, THE Success_Measurement SHALL classify the target as not met.
29. IF a metric sample is below the applicable minimum sample size, THEN THE Success_Measurement SHALL classify the target as insufficient data and report the observed numerator and denominator.
30. IF a required metric source is unavailable for any part of a reporting period, THEN THE Success_Measurement SHALL label the affected metric as unavailable and identify the unavailable source and affected time range.
31. IF a required metric source is unavailable for any part of a reporting period, THEN THE Success_Measurement SHALL preserve every unaffected metric and omit a target classification for the unavailable metric.
32. THE Success_Measurement SHALL calculate each defined metric for every completed weekly reporting period and every completed 28-day reporting period.
