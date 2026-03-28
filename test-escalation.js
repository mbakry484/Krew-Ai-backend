/**
 * Test Escalation Flow Integration
 *
 * This script tests the escalation detection and handling in the system.
 *
 * Run: node test-escalation.js
 */

// Mock environment variables for testing
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://dummy.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'dummy_key_for_testing';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-dummy_key_for_testing';

const { checkEscalation } = require('./lib/claude');

// Test styling
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m'
};

function testHeader(title) {
  console.log('\n' + colors.cyan + colors.bright + '═'.repeat(60) + colors.reset);
  console.log(colors.cyan + colors.bright + title + colors.reset);
  console.log(colors.cyan + '═'.repeat(60) + colors.reset);
}

function testCase(description, passed) {
  const icon = passed ? '✓' : '✗';
  const color = passed ? colors.green : colors.red;
  console.log(`${color}${icon} ${description}${colors.reset}`);
}

function log(emoji, color, message) {
  console.log(`${emoji} ${color}${message}${colors.reset}`);
}

console.log(colors.bright + colors.blue + '\n╔════════════════════════════════════════════════════════╗' + colors.reset);
console.log(colors.bright + colors.blue + '║       ESCALATION FLOW INTEGRATION TEST                 ║' + colors.reset);
console.log(colors.bright + colors.blue + '╚════════════════════════════════════════════════════════╝' + colors.reset);

let passedTests = 0;
let totalTests = 0;

function runTest(description, condition) {
  totalTests++;
  if (condition) passedTests++;
  testCase(description, condition);
  return condition;
}

// Test 1: Exchange Escalation Detection
testHeader('Test 1: Exchange Escalation Detection');
const exchangeReply = "I understand you'd like to exchange this item. Could you share your order number and photos of the issue? Our team will review this right away. ESCALATE_EXCHANGE";
const exchangeResult = checkEscalation(exchangeReply);
runTest('Detects ESCALATE_EXCHANGE keyword', exchangeResult.shouldEscalate === true);
runTest('Correct type: exchange', exchangeResult.type === 'exchange');
runTest('Has reason', exchangeResult.reason !== null);
console.log(colors.gray + JSON.stringify(exchangeResult, null, 2) + colors.reset);

// Test 2: Refund Escalation Detection
testHeader('Test 2: Refund Escalation Detection');
const refundReply = "I'm sorry to hear that. Let me get our team to help you with the refund process. ESCALATE_REFUND";
const refundResult = checkEscalation(refundReply);
runTest('Detects ESCALATE_REFUND keyword', refundResult.shouldEscalate === true);
runTest('Correct type: refund', refundResult.type === 'refund');
runTest('Has reason', refundResult.reason !== null);
console.log(colors.gray + JSON.stringify(refundResult, null, 2) + colors.reset);

// Test 3: Delivery Escalation Detection
testHeader('Test 3: Delivery Escalation Detection');
const deliveryReply = "I apologize for the delay. Let me flag this with our delivery team right away. ESCALATE_DELIVERY";
const deliveryResult = checkEscalation(deliveryReply);
runTest('Detects ESCALATE_DELIVERY keyword', deliveryResult.shouldEscalate === true);
runTest('Correct type: delivery', deliveryResult.type === 'delivery');
runTest('Has reason', deliveryResult.reason !== null);
console.log(colors.gray + JSON.stringify(deliveryResult, null, 2) + colors.reset);

// Test 4: General Escalation Detection
testHeader('Test 4: General Escalation Detection');
const generalReply = "That's an interesting question about job opportunities. Let me connect you with our team. ESCALATE_GENERAL";
const generalResult = checkEscalation(generalReply);
runTest('Detects ESCALATE_GENERAL keyword', generalResult.shouldEscalate === true);
runTest('Correct type: general', generalResult.type === 'general');
runTest('Has reason', generalResult.reason !== null);
console.log(colors.gray + JSON.stringify(generalResult, null, 2) + colors.reset);

// Test 5: No Escalation (Normal Response)
testHeader('Test 5: No Escalation (Normal Response)');
const normalReply = "Great! That product is available for 500 EGP. Would you like to order it?";
const normalResult = checkEscalation(normalReply);
runTest('No escalation detected', normalResult.shouldEscalate === false);
runTest('Type is null', normalResult.type === null);
runTest('Reason is null', normalResult.reason === null);
console.log(colors.gray + JSON.stringify(normalResult, null, 2) + colors.reset);

// Test 6: Case Insensitive Detection
testHeader('Test 6: Case Insensitive Detection');
const lowercaseReply = "Let me help you with that. escalate_exchange";
const lowercaseResult = checkEscalation(lowercaseReply);
runTest('Detects lowercase escalation keyword', lowercaseResult.shouldEscalate === true);
runTest('Correct type: exchange', lowercaseResult.type === 'exchange');
console.log(colors.gray + JSON.stringify(lowercaseResult, null, 2) + colors.reset);

// Test 7: Mixed Case Detection
testHeader('Test 7: Mixed Case Detection');
const mixedReply = "Our team will handle this. EsCaLaTe_ReFuNd";
const mixedResult = checkEscalation(mixedReply);
runTest('Detects mixed case escalation keyword', mixedResult.shouldEscalate === true);
runTest('Correct type: refund', mixedResult.type === 'refund');
console.log(colors.gray + JSON.stringify(mixedResult, null, 2) + colors.reset);

// Test 8: Multiple Keywords (First One Wins)
testHeader('Test 8: Multiple Keywords (First Match Wins)');
const multipleReply = "ESCALATE_EXCHANGE and also ESCALATE_DELIVERY";
const multipleResult = checkEscalation(multipleReply);
runTest('Detects first escalation keyword', multipleResult.shouldEscalate === true);
runTest('Returns exchange (first match)', multipleResult.type === 'exchange');
console.log(colors.gray + JSON.stringify(multipleResult, null, 2) + colors.reset);

// Summary
testHeader('Test Summary');
console.log(`${colors.bright}Total Tests: ${totalTests}${colors.reset}`);
console.log(`${colors.green}✓ Passed: ${passedTests}${colors.reset}`);
console.log(`${colors.red}✗ Failed: ${totalTests - passedTests}${colors.reset}`);

if (passedTests === totalTests) {
  console.log(`\n${colors.green}${colors.bright}✅ ALL TESTS PASSED!${colors.reset}\n`);
} else {
  console.log(`\n${colors.red}${colors.bright}❌ SOME TESTS FAILED${colors.reset}\n`);
}

// Integration Notes
console.log(colors.blue + colors.bright + '\nIntegration Implementation:' + colors.reset);
console.log('  ✅ checkEscalation function imported in routes/instagram.js');
console.log('  ✅ Escalation check added before AI generates reply (line 402-420)');
console.log('  ✅ Escalation detection added after AI generates reply (line 731-759)');
console.log('  ✅ Escalation keywords removed from customer-facing messages');
console.log('  ✅ Conversation marked as escalated in database');
console.log('  ✅ AI stops responding once conversation is escalated');

console.log(colors.blue + '\nNext Steps:' + colors.reset);
console.log('  1. Run the database migration: add-escalation-schema.sql in Supabase');
console.log('  2. Restart your backend server');
console.log('  3. Test with real Instagram messages');
console.log('  4. View escalated conversations: GET /escalations?brand_id=xxx');
console.log('  5. Resolve escalations: POST /escalations/:id/resolve');
console.log('  6. Reopen conversations: POST /escalations/:id/reopen');

console.log(colors.blue + '\nAPI Endpoints:' + colors.reset);
console.log('  GET /escalations?brand_id=xxx          - List escalated conversations');
console.log('  GET /escalations/stats?brand_id=xxx    - Get escalation statistics');
console.log('  POST /escalations/:id/resolve          - Mark escalation resolved');
console.log('  POST /escalations/:id/reopen           - Re-enable AI for conversation');

console.log('\n');
