<?php
/**
 * POST /api/nyx/lambert.php
 *
 * PHP proxy for the nyx-space MCP Lambert solver.
 * Handles MCP session initialization and tool calls to platform.nyxspace.com.
 *
 * Usage: POST JSON body with { initial_state: {...}, final_state: {...} }
 * Returns: { result: { structuredContent: { v_init_x_km_s, ... } } }
 */

// Suppress HTML error output — we're a JSON API, any PHP warnings/deprecations
// must not leak HTML into the response or JSON parsing breaks on the client.
error_reporting(E_ERROR);
ini_set('display_errors', '0');

header('Content-Type: application/json');

// Configuration — load once for CORS, auth check, and the Nyx call below.
$NYX_MCP_URL = 'https://platform.nyxspace.com/mcp';
$NYX_API_KEY = getenv('NYX_API_KEY') ?: '';
$AUTH_HASH = '';
$ALLOWED_ORIGINS = [];
$DEBUG = false;
$configPath = __DIR__ . '/config.local.php';
if (file_exists($configPath)) {
    $cfg = require $configPath;
    if (!$NYX_API_KEY) $NYX_API_KEY = $cfg['api_key'] ?? '';
    $AUTH_HASH = strtolower(trim($cfg['auth_hash'] ?? ''));
    $ALLOWED_ORIGINS = $cfg['allowed_origins'] ?? [];
    $DEBUG = !empty($cfg['debug']);
}

// CORS — only allow listed origins. Same-origin requests don't need this
// (browsers don't send Origin or skip the check), so an empty allow list is
// the safe default for a single-domain deploy.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $ALLOWED_ORIGINS, true)) {
    header("Access-Control-Allow-Origin: $origin");
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Auth');
}

// CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Shared-password auth gate. Client sends SHA-256(password) in X-Auth; we
// compare to the hash configured in config.local.php via hash_equals (timing-
// safe). auth_not_configured = admin has not set auth_hash yet.
if ($AUTH_HASH === '') {
    http_response_code(401);
    echo json_encode(['error' => 'auth_not_configured']);
    exit;
}
$provided = strtolower(trim($_SERVER['HTTP_X_AUTH'] ?? ''));
if (strlen($provided) !== 64 || !hash_equals($AUTH_HASH, $provided)) {
    // Sleep on every auth failure so a brute-force attacker is rate-limited
    // to ~4 attempts/sec per connection. Cheap and effective against casual
    // guessing; not a defense against a determined attacker with many IPs.
    usleep(250000);
    http_response_code(401);
    echo json_encode(['error' => 'auth_required']);
    exit;
}

// Lightweight verification endpoint used by the login UI to check the
// password without triggering a real Lambert call.
if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['ping'] ?? '') === '1') {
    echo json_encode(['ok' => true]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST required']);
    exit;
}

if (!$NYX_API_KEY) {
    http_response_code(500);
    echo json_encode(['error' => 'Nyx API key not configured (set NYX_API_KEY env var or create api/nyx/config.local.php)']);
    exit;
}
$TIMEOUT = 30;

// No on-disk session persistence — every request gets a fresh MCP session.
// On shared hosting (Hosting24) /tmp can be writable by other tenants and
// concurrent users would race-write the file. Adds ~1s of init latency per
// Lambert call; the Lambert solve itself is the dominant cost anyway.

function mcpRequest($method, $params, &$session) {
    global $NYX_MCP_URL, $NYX_API_KEY, $TIMEOUT, $DEBUG;

    $session['rpcId']++;
    $body = [
        'jsonrpc' => '2.0',
        'method' => $method,
        'id' => $session['rpcId'],
    ];
    if ($params !== null) {
        $body['params'] = $params;
    }

    $headers = [
        'Content-Type: application/json',
        'Accept: application/json, text/event-stream',
    ];
    if ($NYX_API_KEY) {
        $headers[] = "Authorization: Bearer $NYX_API_KEY";
    }
    if ($session['sessionId']) {
        $headers[] = "Mcp-Session-Id: " . $session['sessionId'];
    }

    // Use separate header/body callbacks to avoid CURLOPT_HEADER splitting
    // issues with SSE chunked responses.
    $respHeaders = '';
    $respBody = '';

    $ch = curl_init($NYX_MCP_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_TIMEOUT => $TIMEOUT,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
        // Keep reading even when no data flows — the Nyx server sends a
        // keepalive SSE event immediately, then pauses while computing the
        // Lambert solution, then sends the JSON result. Without this, cURL
        // returns after the first chunk (26 bytes of keepalive).
        CURLOPT_LOW_SPEED_LIMIT => 1,    // bytes/sec threshold
        CURLOPT_LOW_SPEED_TIME => $TIMEOUT, // seconds to wait at low speed
        CURLOPT_HEADERFUNCTION => function ($ch, $header) use (&$respHeaders, &$session) {
            $respHeaders .= $header;
            if (preg_match('/^Mcp-Session-Id:\s*(.+)/i', $header, $m)) {
                $session['sessionId'] = trim($m[1]);
            }
            return strlen($header);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$respBody) {
            $respBody .= $chunk;
            return strlen($chunk);
        },
    ]);

    curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    $curlErrno = curl_errno($ch);

    // Debug to PHP server stderr — only when explicitly enabled in
    // config.local.php. The dump includes the Authorization header (our Nyx
    // Bearer token), so it must not be on by default in production.
    if ($DEBUG) {
        $debug = "=== MCP $method ===\n";
        $debug .= "HTTP $httpCode | cURL errno=$curlErrno | body=" . strlen($respBody) . " bytes\n";
        $debug .= "Headers:\n$respHeaders\n";
        $debug .= "Body:\n$respBody\n";
        $debug .= "===================\n";
        file_put_contents('php://stderr', $debug);
    }

    if ($error) {
        throw new Exception("cURL error ($curlErrno): $error");
    }

    if ($httpCode === 404 && strpos($respBody, 'Session not found') !== false) {
        $session['sessionId'] = null;
        $session['initialized'] = false;
        throw new Exception('Nyx session expired');
    }

    if ($httpCode < 200 || $httpCode >= 300) {
        throw new Exception("Nyx MCP returned HTTP $httpCode: " . substr($respBody, 0, 300));
    }

    // Parse response — extract the last `data: {...}` line (SSE with JSON)
    // or fall back to plain JSON parsing.
    $lastJsonData = null;
    foreach (explode("\n", $respBody) as $line) {
        $line = trim($line);
        if (strpos($line, 'data: {') === 0) {
            $lastJsonData = substr($line, 6);
        }
    }
    if ($lastJsonData !== null) {
        $decoded = json_decode($lastJsonData, true);
        if ($decoded !== null) return $decoded;
    }

    // Try plain JSON
    $decoded = json_decode($respBody, true);
    if ($decoded !== null) return $decoded;

    throw new Exception('No JSON in response (' . strlen($respBody) . ' bytes): ' . substr($respBody, 0, 300));
}

function ensureInitialized(&$session) {
    if ($session['initialized']) return;

    $resp = mcpRequest('initialize', [
        'protocolVersion' => '2025-03-26',
        'capabilities' => new stdClass(),
        'clientInfo' => ['name' => 'marslink-php', 'version' => '0.1.0'],
    ], $session);

    if (isset($resp['error'])) {
        throw new Exception('MCP initialize failed: ' . ($resp['error']['message'] ?? 'unknown'));
    }

    // Send initialized notification (no id)
    global $NYX_MCP_URL, $NYX_API_KEY;
    $headers = ['Content-Type: application/json', 'Accept: application/json, text/event-stream'];
    if ($NYX_API_KEY) $headers[] = "Authorization: Bearer $NYX_API_KEY";
    if ($session['sessionId']) $headers[] = "Mcp-Session-Id: " . $session['sessionId'];

    $ch = curl_init($NYX_MCP_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['jsonrpc' => '2.0', 'method' => 'notifications/initialized']),
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
    ]);
    curl_exec($ch);

    $session['initialized'] = true;
}

// Main handler
try {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['initial_state']) || !isset($input['final_state'])) {
        http_response_code(400);
        echo json_encode(['error' => 'initial_state and final_state are required']);
        exit;
    }

    // Fresh session each request (see note above mcpRequest).
    $session = ['sessionId' => null, 'initialized' => false, 'rpcId' => 0];

    // Retry once on session expiry
    for ($attempt = 0; $attempt < 2; $attempt++) {
        try {
            ensureInitialized($session);

            $toolArgs = [
                'initial_state' => [
                    'epoch' => $input['initial_state']['epoch'],
                    'x_km' => $input['initial_state']['x_km'],
                    'y_km' => $input['initial_state']['y_km'],
                    'z_km' => $input['initial_state']['z_km'],
                    'vx_km_s' => $input['initial_state']['vx_km_s'],
                    'vy_km_s' => $input['initial_state']['vy_km_s'],
                    'vz_km_s' => $input['initial_state']['vz_km_s'],
                    'center_object' => $input['initial_state']['center_object'] ?? 10,
                    'ref_frame' => $input['initial_state']['ref_frame'] ?? 1,
                ],
                'final_state' => [
                    'epoch' => $input['final_state']['epoch'],
                    'x_km' => $input['final_state']['x_km'],
                    'y_km' => $input['final_state']['y_km'],
                    'z_km' => $input['final_state']['z_km'],
                    'vx_km_s' => $input['final_state']['vx_km_s'],
                    'vy_km_s' => $input['final_state']['vy_km_s'],
                    'vz_km_s' => $input['final_state']['vz_km_s'],
                    'center_object' => $input['final_state']['center_object'] ?? 10,
                    'ref_frame' => $input['final_state']['ref_frame'] ?? 1,
                ],
            ];

            $resp = mcpRequest('tools/call', [
                'name' => 'lambert_solver',
                'arguments' => $toolArgs,
            ], $session);

            if (isset($resp['error'])) {
                throw new Exception('Lambert solver failed: ' . ($resp['error']['message'] ?? 'unknown'));
            }

            echo json_encode(['result' => $resp['result']]);
            exit;

        } catch (Exception $e) {
            if (strpos($e->getMessage(), 'session expired') !== false && $attempt === 0) {
                $session['sessionId'] = null;
                $session['initialized'] = false;
                continue;
            }
            throw $e;
        }
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
