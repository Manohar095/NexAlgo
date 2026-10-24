# app.py
# -*- coding: utf-8 -*-
"""
Flask web application for Flattrade Broker integration
Search symbols, get quotes, orderbook, tradebook, positionbook
"""

import logging
import json
import os
import sys
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS

# Import your broker session
from strategy.broker import BrokerSession
from config.settings import settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Initialize broker session
broker = BrokerSession.get()

# ============================================================
# ROUTES
# ============================================================

@app.route('/')
def index():
    """Main dashboard page - Search and get quotes"""
    return render_template('index.html')

@app.route('/api/search/scrip', methods=['POST'])
def search_scrip():
    """Search for scrips using broker API"""
    try:
        data = request.json
        search_text = data.get('search_text', '').strip().upper()
        exchange = data.get('exchange', '').strip().upper()
        
        if not search_text:
            return jsonify({
                'success': False,
                'error': 'Search text cannot be empty'
            }), 400
        
        if not exchange:
            return jsonify({
                'success': False,
                'error': 'Exchange cannot be empty'
            }), 400
        
        # Use the broker's search function
        results = broker.search_symbols(exchange, search_text)
        
        # Format results for display
        formatted_results = []
        if results and isinstance(results, dict):
            # Handle different response formats
            if 'values' in results:
                formatted_results = results['values']
            elif isinstance(results, list):
                formatted_results = results
            else:
                # Try to extract from response
                for key, value in results.items():
                    if isinstance(value, list):
                        formatted_results = value
                        break
        
        return jsonify({
            'success': True,
            'data': formatted_results,
            'count': len(formatted_results) if formatted_results else 0
        })
        
    except Exception as e:
        logger.error(f"Search error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/search/direct', methods=['POST'])
def search_scrip_direct():
    """Direct search using requests (alternative method)"""
    try:
        import requests
        
        data = request.json
        search_text = data.get('search_text', '').strip().upper()
        exchange = data.get('exchange', '').strip().upper()
        
        if not search_text or not exchange:
            return jsonify({
                'success': False,
                'error': 'Search text and exchange are required'
            }), 400
        
        # Get credentials from settings
        uid = settings.FT_USER
        token = settings.FT_ACCESS_TOKEN
        
        if not uid or not token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        url = "https://piconnect.flattrade.in/PiConnectAPI/SearchScrip"
        
        jdata = {
            "uid": uid,
            "stext": search_text,
            "exch": exchange
        }
        
        request_body = (
            "jData=" + json.dumps(jdata, separators=(",", ":")) +
            "&jKey=" + token
        )
        
        headers = {
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            url,
            headers=headers,
            data=request_body,
            timeout=10
        )
        
        response.raise_for_status()
        result = response.json()
        
        if result.get("stat") == "Ok":
            values = result.get("values", [])
            return jsonify({
                'success': True,
                'data': values,
                'count': len(values)
            })
        else:
            return jsonify({
                'success': False,
                'error': result.get('emsg', 'Search failed'),
                'stat': result.get('stat')
            })
            
    except Exception as e:
        logger.error(f"Direct search error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/get/quotes', methods=['POST'])
def get_quotes():
    """Get quotes for a specific token using direct API"""
    try:
        import requests
        
        data = request.json
        exchange = data.get('exchange', '').strip().upper()
        token = data.get('token', '').strip()
        
        if not exchange:
            return jsonify({
                'success': False,
                'error': 'Exchange is required'
            }), 400
        
        if not token:
            return jsonify({
                'success': False,
                'error': 'Token is required'
            }), 400
        
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        url = "https://piconnect.flattrade.in/PiConnectAPI/GetQuotes"
        
        jdata = {
            "uid": uid,
            "exch": exchange,
            "token": token
        }
        
        request_body = (
            "jData=" + json.dumps(jdata, separators=(",", ":")) +
            "&jKey=" + access_token
        )
        
        headers = {
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            url,
            headers=headers,
            data=request_body,
            timeout=10
        )
        
        response.raise_for_status()
        result = response.json()
        
        if result.get("stat") == "Ok":
            # Return the specific fields requested
            formatted_data = {
                'success': True,
                'data': {
                    'cname': result.get('cname', 'N/A'),
                    'exch': result.get('exch', 'N/A'),
                    'exd': result.get('exd', 'N/A'),
                    'instname': result.get('instname', 'N/A'),
                    'ls': result.get('ls', 'N/A'),
                    'optt': result.get('optt', 'N/A'),
                    'ti': result.get('ti', 'N/A'),
                    'token': result.get('token', 'N/A'),
                    'tsym': result.get('tsym', 'N/A')
                }
            }
            return jsonify(formatted_data)
        else:
            return jsonify({
                'success': False,
                'error': result.get('emsg', 'Failed to get quotes'),
                'stat': result.get('stat')
            })
            
    except Exception as e:
        logger.error(f"Get quotes error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/get/quotes/broker', methods=['POST'])
def get_quotes_broker():
    """Get quotes using broker's get_quotes method"""
    try:
        data = request.json
        exchange = data.get('exchange', '').strip().upper()
        token = data.get('token', '').strip()
        
        if not exchange:
            return jsonify({
                'success': False,
                'error': 'Exchange is required'
            }), 400
        
        if not token:
            return jsonify({
                'success': False,
                'error': 'Token is required'
            }), 400
        
        # Use broker's get_quotes method
        result = broker.get_quotes(exchange=exchange, token=token)
        
        if result and result.get('stat') == 'Ok':
            # Return the specific fields requested
            formatted_data = {
                'success': True,
                'data': {
                    'cname': result.get('cname', 'N/A'),
                    'exch': result.get('exch', 'N/A'),
                    'exd': result.get('exd', 'N/A'),
                    'instname': result.get('instname', 'N/A'),
                    'ls': result.get('ls', 'N/A'),
                    'optt': result.get('optt', 'N/A'),
                    'ti': result.get('ti', 'N/A'),
                    'token': result.get('token', 'N/A'),
                    'tsym': result.get('tsym', 'N/A')
                }
            }
            return jsonify(formatted_data)
        else:
            error_msg = result.get('emsg', 'Failed to get quotes') if result else 'No response from broker'
            return jsonify({
                'success': False,
                'error': error_msg
            })
            
    except Exception as e:
        logger.error(f"Get quotes broker error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ============================================================
# ORDERBOOK ROUTES
# ============================================================

@app.route('/api/orderbook', methods=['POST'])
def get_orderbook():
    """Get orderbook using direct API"""
    try:
        import requests
        
        data = request.json
        prd = data.get('prd', '').strip().upper()  # Optional product filter
        
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        url = "https://piconnect.flattrade.in/PiConnectAPI/OrderBook"
        
        jdata = {
            "uid": uid
        }
        
        # Add optional product filter
        if prd:
            jdata["prd"] = prd
        
        request_body = (
            "jData=" + json.dumps(jdata, separators=(",", ":")) +
            "&jKey=" + access_token
        )
        
        headers = {
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            url,
            headers=headers,
            data=request_body,
            timeout=10
        )
        
        response.raise_for_status()
        result = response.json()
        
        # Check if result is a list (success) or dict (error)
        if isinstance(result, list):
            # Success - data is a list of orders
            return jsonify({
                'success': True,
                'data': result,
                'count': len(result)
            })
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            # Some responses might be wrapped in a dict
            return jsonify({
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            })
        else:
            # Error response
            error_msg = result.get('emsg', 'Failed to fetch orderbook') if isinstance(result, dict) else 'Unknown error'
            return jsonify({
                'success': False,
                'error': error_msg,
                'stat': result.get('stat') if isinstance(result, dict) else None
            })
            
    except Exception as e:
        logger.error(f"Orderbook error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/orderbook/broker', methods=['POST'])
def get_orderbook_broker():
    """Get orderbook using broker's method (if available)"""
    try:
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        # Try to use broker's method if available
        if hasattr(broker, 'get_orderbook'):
            result = broker.get_orderbook()
        else:
            # Fallback to direct API
            return get_orderbook()
        
        if isinstance(result, list):
            return jsonify({
                'success': True,
                'data': result,
                'count': len(result)
            })
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return jsonify({
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            })
        else:
            error_msg = result.get('emsg', 'Failed to fetch orderbook') if isinstance(result, dict) else 'Unknown error'
            return jsonify({
                'success': False,
                'error': error_msg
            })
            
    except Exception as e:
        logger.error(f"Orderbook broker error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ============================================================
# TRADEBOOK ROUTES
# ============================================================

@app.route('/api/tradebook', methods=['POST'])
def get_tradebook():
    """Get tradebook using direct API"""
    try:
        import requests
        
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        url = "https://piconnect.flattrade.in/PiConnectAPI/TradeBook"
        
        jdata = {
            "uid": uid,
            "actid": uid  # Account ID is same as UID
        }
        
        request_body = (
            "jData=" + json.dumps(jdata, separators=(",", ":")) +
            "&jKey=" + access_token
        )
        
        headers = {
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            url,
            headers=headers,
            data=request_body,
            timeout=10
        )
        
        response.raise_for_status()
        result = response.json()
        
        # Check if result is a list (success) or dict (error)
        if isinstance(result, list):
            # Success - data is a list of trades
            return jsonify({
                'success': True,
                'data': result,
                'count': len(result)
            })
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            # Some responses might be wrapped in a dict
            return jsonify({
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            })
        else:
            # Error response
            error_msg = result.get('emsg', 'Failed to fetch tradebook') if isinstance(result, dict) else 'Unknown error'
            return jsonify({
                'success': False,
                'error': error_msg,
                'stat': result.get('stat') if isinstance(result, dict) else None
            })
            
    except Exception as e:
        logger.error(f"Tradebook error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/tradebook/broker', methods=['POST'])
def get_tradebook_broker():
    """Get tradebook using broker's method (if available)"""
    try:
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        # Try to use broker's method if available
        if hasattr(broker, 'get_tradebook'):
            result = broker.get_tradebook()
        else:
            # Fallback to direct API
            return get_tradebook()
        
        if isinstance(result, list):
            return jsonify({
                'success': True,
                'data': result,
                'count': len(result)
            })
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return jsonify({
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            })
        else:
            error_msg = result.get('emsg', 'Failed to fetch tradebook') if isinstance(result, dict) else 'Unknown error'
            return jsonify({
                'success': False,
                'error': error_msg
            })
            
    except Exception as e:
        logger.error(f"Tradebook broker error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ============================================================
# POSITIONBOOK ROUTES
# ============================================================

@app.route('/api/positionbook', methods=['POST'])
def get_positionbook():
    """Get positionbook using direct API"""
    try:
        import requests
        
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        url = "https://piconnect.flattrade.in/PiConnectAPI/PositionBook"
        
        jdata = {
            "uid": uid,
            "actid": uid  # Account ID is same as UID
        }
        
        request_body = (
            "jData=" + json.dumps(jdata, separators=(",", ":")) +
            "&jKey=" + access_token
        )
        
        headers = {
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            url,
            headers=headers,
            data=request_body,
            timeout=10
        )
        
        response.raise_for_status()
        result = response.json()
        
        # Check if result is a list (success) or dict (error)
        if isinstance(result, list):
            # Success - data is a list of positions
            return jsonify({
                'success': True,
                'data': result,
                'count': len(result)
            })
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            # Some responses might be wrapped in a dict
            return jsonify({
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            })
        else:
            # Error response
            error_msg = result.get('emsg', 'Failed to fetch positionbook') if isinstance(result, dict) else 'Unknown error'
            return jsonify({
                'success': False,
                'error': error_msg,
                'stat': result.get('stat') if isinstance(result, dict) else None
            })
            
    except Exception as e:
        logger.error(f"Positionbook error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/api/positionbook/broker', methods=['POST'])
def get_positionbook_broker():
    """Get positionbook using broker's method (if available)"""
    try:
        # Get credentials from settings
        uid = settings.FT_USER
        access_token = settings.FT_ACCESS_TOKEN
        
        if not uid or not access_token:
            return jsonify({
                'success': False,
                'error': 'Broker credentials not configured'
            }), 400
        
        # Try to use broker's method if available
        if hasattr(broker, 'get_positionbook'):
            result = broker.get_positionbook()
        else:
            # Fallback to direct API
            return get_positionbook()
        
        if isinstance(result, list):
            return jsonify({
                'success': True,
                'data': result,
                'count': len(result)
            })
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return jsonify({
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            })
        else:
            error_msg = result.get('emsg', 'Failed to fetch positionbook') if isinstance(result, dict) else 'Unknown error'
            return jsonify({
                'success': False,
                'error': error_msg
            })
            
    except Exception as e:
        logger.error(f"Positionbook broker error: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

# ============================================================
# CREATE TEMPLATES DIRECTORY AND HTML FILE
# ============================================================

# Create templates directory if it doesn't exist
os.makedirs('templates', exist_ok=True)

# Write the HTML template with proper encoding
template_path = os.path.join('templates', 'index.html')
with open(template_path, 'w', encoding='utf-8') as f:
    f.write('''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flattrade - Trading Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #f5f7fa;
            color: #2d3748;
            line-height: 1.6;
            padding: 20px;
        }

        .container {
            max-width: 1600px;
            margin: 0 auto;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
            flex-wrap: wrap;
            gap: 12px;
        }

        .header h1 {
            font-size: 28px;
            font-weight: 700;
            color: #2d3748;
        }

        .header h1 span {
            color: #667eea;
        }

        .header-actions {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }

        .card {
            background: white;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }

        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            flex-wrap: wrap;
            gap: 12px;
        }

        .card-header h2 {
            font-size: 20px;
            font-weight: 600;
            color: #2d3748;
        }

        .card-header .badge-count {
            background: #667eea;
            color: white;
            padding: 2px 12px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
        }

        .form-group {
            margin-bottom: 16px;
        }

        .form-group label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            color: #4a5568;
            margin-bottom: 4px;
        }

        .form-group input, 
        .form-group select {
            width: 100%;
            padding: 10px 14px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.2s;
        }

        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .form-row {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 16px;
        }

        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn-primary {
            background: #667eea;
            color: white;
        }

        .btn-primary:hover {
            background: #5a67d8;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }

        .btn-success {
            background: #48bb78;
            color: white;
        }

        .btn-success:hover {
            background: #38a169;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(72, 187, 120, 0.3);
        }

        .btn-warning {
            background: #ed8936;
            color: white;
        }

        .btn-warning:hover {
            background: #dd6b20;
            transform: translateY(-1px);
        }

        .btn-danger {
            background: #fc8181;
            color: white;
        }

        .btn-danger:hover {
            background: #f56565;
            transform: translateY(-1px);
        }

        .btn-info {
            background: #4299e1;
            color: white;
        }

        .btn-info:hover {
            background: #3182ce;
            transform: translateY(-1px);
        }

        .btn-purple {
            background: #9f7aea;
            color: white;
        }

        .btn-purple:hover {
            background: #805ad5;
            transform: translateY(-1px);
        }

        .btn-sm {
            padding: 6px 12px;
            font-size: 12px;
        }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none !important;
        }

        .button-group {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
            margin-top: 8px;
        }

        .tab-container {
            display: flex;
            gap: 4px;
            background: #f7fafc;
            padding: 4px;
            border-radius: 10px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }

        .tab-btn {
            padding: 10px 24px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            background: transparent;
            color: #4a5568;
        }

        .tab-btn:hover {
            background: #edf2f7;
        }

        .tab-btn.active {
            background: white;
            color: #667eea;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        .results-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
            margin-top: 8px;
        }

        .results-table thead {
            background: #f7fafc;
        }

        .results-table th {
            padding: 10px 12px;
            text-align: left;
            font-weight: 600;
            color: #4a5568;
            border-bottom: 2px solid #e2e8f0;
            white-space: nowrap;
            position: sticky;
            top: 0;
            background: #f7fafc;
            z-index: 10;
        }

        .results-table td {
            padding: 8px 12px;
            border-bottom: 1px solid #e2e8f0;
            vertical-align: middle;
        }

        .results-table tr:hover {
            background: #f7fafc;
        }

        .results-table .table-wrap {
            overflow-x: auto;
            max-height: 500px;
            overflow-y: auto;
        }

        .badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
        }

        .badge-info {
            background: #bee3f8;
            color: #2a4365;
        }

        .badge-success {
            background: #c6f6d5;
            color: #22543d;
        }

        .badge-danger {
            background: #fed7d7;
            color: #742a2a;
        }

        .badge-warning {
            background: #feebc8;
            color: #744210;
        }

        .badge-purple {
            background: #e9d8fd;
            color: #553c9a;
        }

        .badge-open {
            background: #bee3f8;
            color: #2a4365;
        }

        .badge-filled {
            background: #c6f6d5;
            color: #22543d;
        }

        .badge-rejected {
            background: #fed7d7;
            color: #742a2a;
        }

        .badge-cancelled {
            background: #feebc8;
            color: #744210;
        }

        .badge-partial {
            background: #fbd38d;
            color: #744210;
        }

        .badge-complete {
            background: #9ae6b4;
            color: #22543d;
        }

        .badge-buy {
            background: #c6f6d5;
            color: #22543d;
        }

        .badge-sell {
            background: #fed7d7;
            color: #742a2a;
        }

        .alert {
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 16px;
            font-size: 14px;
        }

        .alert-success {
            background: #c6f6d5;
            color: #22543d;
            border: 1px solid #9ae6b4;
        }

        .alert-error {
            background: #fed7d7;
            color: #742a2a;
            border: 1px solid #fc8181;
        }

        .alert-info {
            background: #bee3f8;
            color: #2a4365;
            border: 1px solid #90cdf4;
        }

        .alert-warning {
            background: #feebc8;
            color: #744210;
            border: 1px solid #f6ad55;
        }

        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }

        .loading.active {
            display: block;
        }

        .spinner {
            display: inline-block;
            width: 30px;
            height: 30px;
            border: 3px solid #e2e8f0;
            border-top-color: #667eea;
            border-radius: 50%;
            animation: spin 0.6s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .hidden {
            display: none !important;
        }

        .text-muted {
            color: #718096;
            font-size: 13px;
        }

        .text-center {
            text-align: center;
        }

        .text-right {
            text-align: right;
        }

        code {
            background: #f7fafc;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 12px;
            font-family: 'Courier New', monospace;
        }

        .mt-16 {
            margin-top: 16px;
        }

        .mb-16 {
            margin-bottom: 16px;
        }

        .quote-details {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin: 16px 0;
        }

        .quote-item {
            background: #f7fafc;
            padding: 12px 16px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .quote-item .label {
            font-size: 13px;
            color: #718096;
            font-weight: 500;
        }

        .quote-item .value {
            font-size: 14px;
            font-weight: 600;
            color: #2d3748;
        }

        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
            overflow: auto;
        }

        .modal-content {
            background-color: white;
            margin: 30px auto;
            padding: 30px;
            border-radius: 12px;
            max-width: 800px;
            position: relative;
            max-height: 90vh;
            overflow-y: auto;
        }

        .modal-close {
            position: absolute;
            right: 20px;
            top: 20px;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
            color: #718096;
            transition: color 0.2s;
            z-index: 10;
        }

        .modal-close:hover {
            color: #2d3748;
        }

        .modal-title {
            font-size: 22px;
            font-weight: 600;
            margin-bottom: 20px;
            color: #2d3748;
            padding-right: 40px;
        }

        .auto-refresh {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: #718096;
        }

        .auto-refresh input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }

        .status-summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }

        .status-item {
            background: #f7fafc;
            padding: 8px 12px;
            border-radius: 8px;
            text-align: center;
        }

        .status-item .label {
            font-size: 12px;
            color: #718096;
        }

        .status-item .count {
            font-size: 20px;
            font-weight: 700;
        }

        .status-item .count.open { color: #4299e1; }
        .status-item .count.filled { color: #48bb78; }
        .status-item .count.rejected { color: #fc8181; }
        .status-item .count.cancelled { color: #ed8936; }
        .status-item .count.partial { color: #d69e2e; }

        @media (max-width: 768px) {
            .form-row {
                grid-template-columns: 1fr;
            }
            
            .button-group {
                flex-direction: column;
            }
            
            .button-group .btn {
                width: 100%;
                justify-content: center;
            }

            .quote-details {
                grid-template-columns: 1fr;
            }

            .modal-content {
                margin: 10px;
                padding: 20px;
            }

            .header {
                flex-direction: column;
                align-items: flex-start;
            }

            .tab-container {
                flex-direction: column;
            }

            .tab-btn {
                width: 100%;
                text-align: center;
            }

            .status-summary {
                grid-template-columns: repeat(2, 1fr);
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <h1>📊 Flattrade <span>Dashboard</span></h1>
            <div class="header-actions">
                <button class="btn btn-success btn-sm" onclick="refreshAll()">🔄 Refresh All</button>
            </div>
        </div>

        <!-- Alert Container -->
        <div id="alertContainer"></div>

        <!-- Search Card -->
        <div class="card">
            <div class="card-header">
                <h2>🔍 Search Symbol</h2>
            </div>
            
            <div class="form-row">
                <div class="form-group">
                    <label for="searchText">Symbol / Search Text</label>
                    <input type="text" id="searchText" placeholder="e.g., RELIANCE, TATASTEEL" />
                </div>
                <div class="form-group">
                    <label for="exchangeSelect">Exchange</label>
                    <select id="exchangeSelect">
                        <option value="NSE">NSE</option>
                        <option value="BSE">BSE</option>
                        <option value="NFO">NFO</option>
                        <option value="BFO">BFO</option>
                        <option value="MCX">MCX</option>
                    </select>
                </div>
            </div>
            
            <div class="button-group">
                <button class="btn btn-primary" onclick="searchScrip()">Search</button>
                <button class="btn btn-warning" onclick="searchScripDirect()">Search (Direct API)</button>
                <button class="btn btn-sm" onclick="clearResults()">Clear</button>
            </div>
            
            <div class="loading" id="searchLoading">
                <div class="spinner"></div>
                <p style="margin-top: 8px; color: #718096;">Searching...</p>
            </div>

            <div id="resultsContainer" class="mt-16 hidden">
                <h3>Results <span id="resultCount" class="text-muted"></span></h3>
                <div id="resultsTableContainer"></div>
            </div>
        </div>

        <!-- Dashboard Tabs -->
        <div class="card">
            <div class="tab-container">
                <button class="tab-btn active" data-tab="orders" onclick="switchTab('orders')">
                    📋 Orders
                </button>
                <button class="tab-btn" data-tab="trades" onclick="switchTab('trades')">
                    💰 Trades
                </button>
                <button class="tab-btn" data-tab="positions" onclick="switchTab('positions')">
                    📈 Positions
                </button>
            </div>

            <!-- Orderbook Tab -->
            <div id="tab-orders" class="tab-content active">
                <div class="card-header">
                    <div>
                        <h2>📋 Orderbook</h2>
                        <span class="text-muted" id="orderbookTimestamp"></span>
                    </div>
                    <div class="auto-refresh">
                        <input type="checkbox" id="orderbookAutoRefresh" checked onchange="toggleAutoRefresh('orderbook')">
                        <label for="orderbookAutoRefresh">Auto-refresh (30s)</label>
                        <button class="btn btn-primary btn-sm" onclick="fetchOrderbook()">🔄 Refresh</button>
                    </div>
                </div>
                <div id="orderbookStatus" class="status-summary"></div>
                <div class="loading" id="orderbookLoading">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: #718096;">Loading orders...</p>
                </div>
                <div id="orderbookContent"></div>
            </div>

            <!-- Tradebook Tab -->
            <div id="tab-trades" class="tab-content">
                <div class="card-header">
                    <div>
                        <h2>💰 Tradebook</h2>
                        <span class="text-muted" id="tradebookTimestamp"></span>
                    </div>
                    <div class="auto-refresh">
                        <input type="checkbox" id="tradebookAutoRefresh" checked onchange="toggleAutoRefresh('tradebook')">
                        <label for="tradebookAutoRefresh">Auto-refresh (30s)</label>
                        <button class="btn btn-primary btn-sm" onclick="fetchTradebook()">🔄 Refresh</button>
                    </div>
                </div>
                <div class="loading" id="tradebookLoading">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: #718096;">Loading trades...</p>
                </div>
                <div id="tradebookContent"></div>
            </div>

            <!-- Positionbook Tab -->
            <div id="tab-positions" class="tab-content">
                <div class="card-header">
                    <div>
                        <h2>📈 Positionbook</h2>
                        <span class="text-muted" id="positionbookTimestamp"></span>
                    </div>
                    <div class="auto-refresh">
                        <input type="checkbox" id="positionbookAutoRefresh" checked onchange="toggleAutoRefresh('positionbook')">
                        <label for="positionbookAutoRefresh">Auto-refresh (30s)</label>
                        <button class="btn btn-primary btn-sm" onclick="fetchPositionbook()">🔄 Refresh</button>
                    </div>
                </div>
                <div class="loading" id="positionbookLoading">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: #718096;">Loading positions...</p>
                </div>
                <div id="positionbookContent"></div>
            </div>
        </div>

        <!-- Quotes Modal -->
        <div id="quotesModal" class="modal">
            <div class="modal-content">
                <span class="modal-close" onclick="closeQuotesModal()">&times;</span>
                <div class="modal-title" id="modalTitle">Quote Details</div>
                <div id="modalLoading" class="loading">
                    <div class="spinner"></div>
                    <p style="margin-top: 8px; color: #718096;">Fetching quotes...</p>
                </div>
                <div id="modalContent"></div>
            </div>
        </div>
    </div>

    <script>
        // ============================================================
        // STATE
        // ============================================================

        let currentResults = [];
        let autoRefreshIntervals = {};

        // ============================================================
        // UTILITY FUNCTIONS
        // ============================================================

        function showAlert(message, type = 'info') {
            const container = document.getElementById('alertContainer');
            const alert = document.createElement('div');
            alert.className = `alert alert-${type}`;
            alert.textContent = message;
            container.appendChild(alert);
            
            setTimeout(() => {
                if (alert.parentNode) {
                    alert.remove();
                }
            }, 5000);
        }

        function showLoading(elementId, show) {
            document.getElementById(elementId).classList.toggle('active', show);
        }

        function formatDate(dateStr) {
            if (!dateStr) return 'N/A';
            try {
                const d = new Date(dateStr);
                return d.toLocaleString();
            } catch {
                return dateStr;
            }
        }

        function getStatusBadge(status) {
            const statusMap = {
                'Open': 'badge-open',
                'Filled': 'badge-filled',
                'REJECT': 'badge-rejected',
                'Rejected': 'badge-rejected',
                'Cancel': 'badge-cancelled',
                'Cancelled': 'badge-cancelled',
                'Partial': 'badge-partial',
                'Complete': 'badge-complete'
            };
            const cls = statusMap[status] || 'badge-info';
            return `<span class="badge ${cls}">${status || 'N/A'}</span>`;
        }

        function getSideBadge(side) {
            if (side === 'B' || side === 'BUY') {
                return `<span class="badge badge-success">BUY</span>`;
            } else if (side === 'S' || side === 'SELL') {
                return `<span class="badge badge-danger">SELL</span>`;
            }
            return `<span class="badge badge-info">${side || 'N/A'}</span>`;
        }

        function clearResults() {
            currentResults = [];
            document.getElementById('resultsContainer').classList.add('hidden');
            document.getElementById('resultsTableContainer').innerHTML = '';
        }

        // ============================================================
        // TAB SWITCHING
        // ============================================================

        function switchTab(tabName) {
            // Update tab buttons
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tabName);
            });
            
            // Update tab content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.toggle('active', content.id === `tab-${tabName}`);
            });
            
            // Fetch data if not loaded
            if (tabName === 'orders') fetchOrderbook();
            if (tabName === 'trades') fetchTradebook();
            if (tabName === 'positions') fetchPositionbook();
        }

        // ============================================================
        // SEARCH API CALLS
        // ============================================================

        async function searchScrip() {
            const searchText = document.getElementById('searchText').value.trim();
            const exchange = document.getElementById('exchangeSelect').value;
            
            if (!searchText) {
                showAlert('Please enter a symbol to search', 'error');
                return;
            }
            
            showLoading('searchLoading', true);
            
            try {
                const response = await fetch('/api/search/scrip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ search_text: searchText, exchange })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayResults(data.data, data.count);
                    showAlert(`Found ${data.count} results`, 'success');
                } else {
                    showAlert('Search failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Search error:', error);
                showAlert('Error during search', 'error');
            } finally {
                showLoading('searchLoading', false);
            }
        }

        async function searchScripDirect() {
            const searchText = document.getElementById('searchText').value.trim();
            const exchange = document.getElementById('exchangeSelect').value;
            
            if (!searchText) {
                showAlert('Please enter a symbol to search', 'error');
                return;
            }
            
            showLoading('searchLoading', true);
            
            try {
                const response = await fetch('/api/search/direct', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ search_text: searchText, exchange })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    displayResults(data.data, data.count);
                    showAlert(`Found ${data.count} results`, 'success');
                } else {
                    showAlert('Search failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                console.error('Direct search error:', error);
                showAlert('Error during direct search', 'error');
            } finally {
                showLoading('searchLoading', false);
            }
        }

        // ============================================================
        // QUOTES API CALLS
        // ============================================================

        async function getQuotes(exchange, token, symbol) {
            const modal = document.getElementById('quotesModal');
            const modalContent = document.getElementById('modalContent');
            const modalLoading = document.getElementById('modalLoading');
            const modalTitle = document.getElementById('modalTitle');
            
            modalTitle.textContent = `Quote Details - ${symbol}`;
            modalContent.innerHTML = '';
            modalLoading.classList.add('active');
            modal.style.display = 'block';
            
            try {
                const response = await fetch('/api/get/quotes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ exchange, token })
                });
                
                const data = await response.json();
                modalLoading.classList.remove('active');
                
                if (data.success) {
                    displayQuotesInModal(data.data);
                } else {
                    modalContent.innerHTML = `<div class="alert alert-error">Failed to get quotes: ${data.error || 'Unknown error'}</div>`;
                }
            } catch (error) {
                console.error('Get quotes error:', error);
                modalLoading.classList.remove('active');
                modalContent.innerHTML = '<div class="alert alert-error">Error fetching quotes</div>';
            }
        }

        async function getQuotesBroker(exchange, token, symbol) {
            const modal = document.getElementById('quotesModal');
            const modalContent = document.getElementById('modalContent');
            const modalLoading = document.getElementById('modalLoading');
            const modalTitle = document.getElementById('modalTitle');
            
            modalTitle.textContent = `Quote Details - ${symbol} (via Broker)`;
            modalContent.innerHTML = '';
            modalLoading.classList.add('active');
            modal.style.display = 'block';
            
            try {
                const response = await fetch('/api/get/quotes/broker', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ exchange, token })
                });
                
                const data = await response.json();
                modalLoading.classList.remove('active');
                
                if (data.success) {
                    displayQuotesInModal(data.data);
                } else {
                    modalContent.innerHTML = `<div class="alert alert-error">Failed to get quotes: ${data.error || 'Unknown error'}</div>`;
                }
            } catch (error) {
                console.error('Get quotes broker error:', error);
                modalLoading.classList.remove('active');
                modalContent.innerHTML = '<div class="alert alert-error">Error fetching quotes</div>';
            }
        }

        // ============================================================
        // ORDERBOOK API CALLS
        // ============================================================

        async function fetchOrderbook() {
            showLoading('orderbookLoading', true);
            
            try {
                const response = await fetch('/api/orderbook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                
                const data = await response.json();
                showLoading('orderbookLoading', false);
                
                if (data.success) {
                    displayOrderbook(data.data);
                    document.getElementById('orderbookTimestamp').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
                } else {
                    document.getElementById('orderbookContent').innerHTML = `<div class="alert alert-error">Failed to load orders: ${data.error || 'Unknown error'}</div>`;
                }
            } catch (error) {
                console.error('Orderbook error:', error);
                showLoading('orderbookLoading', false);
                document.getElementById('orderbookContent').innerHTML = '<div class="alert alert-error">Error fetching orderbook</div>';
            }
        }

        function displayOrderbook(orders) {
            const container = document.getElementById('orderbookContent');
            
            if (!orders || orders.length === 0) {
                container.innerHTML = '<p class="text-muted text-center">No orders found</p>';
                document.getElementById('orderbookStatus').innerHTML = '';
                return;
            }

            // Status summary
            const statusCounts = {};
            orders.forEach(order => {
                const status = order.status || 'Unknown';
                statusCounts[status] = (statusCounts[status] || 0) + 1;
            });

            let statusHtml = '';
            const statusColors = {
                'Open': 'open',
                'Filled': 'filled',
                'Complete': 'filled',
                'REJECT': 'rejected',
                'Rejected': 'rejected',
                'Cancel': 'cancelled',
                'Cancelled': 'cancelled',
                'Partial': 'partial'
            };
            for (const [status, count] of Object.entries(statusCounts)) {
                const cls = statusColors[status] || 'open';
                statusHtml += `
                    <div class="status-item">
                        <div class="label">${status}</div>
                        <div class="count ${cls}">${count}</div>
                    </div>
                `;
            }
            document.getElementById('orderbookStatus').innerHTML = statusHtml;

            // Table
            let html = '<div class="table-wrap"><table class="results-table"><thead><tr>';
            html += '<th>#</th>';
            html += '<th>Order ID</th>';
            html += '<th>Exchange</th>';
            html += '<th>Symbol</th>';
            html += '<th>Side</th>';
            html += '<th>Qty</th>';
            html += '<th>Price</th>';
            html += '<th>Filled</th>';
            html += '<th>Avg Price</th>';
            html += '<th>Status</th>';
            html += '<th>Product</th>';
            html += '<th>Validity</th>';
            html += '<th>AMO</th>';
            html += '</tr></thead><tbody>';

            orders.forEach((order, index) => {
                html += `<tr>
                    <td>${index + 1}</td>
                    <td><code>${order.norenordno || '-'}</code></td>
                    <td><span class="badge badge-info">${order.exch || '-'}</span></td>
                    <td><strong>${order.tsym || '-'}</strong></td>
                    <td>${getSideBadge(order.trantype)}</td>
                    <td>${order.qty || '-'}</td>
                    <td>${order.prc || '-'}</td>
                    <td>${order.fillshares || '0'}</td>
                    <td>${order.avgprc || '0'}</td>
                    <td>${getStatusBadge(order.status)}</td>
                    <td>${order.prd || '-'}</td>
                    <td>${order.ret || '-'}</td>
                    <td>${order.amo || '-'}</td>
                </tr>`;
            });

            html += '</tbody></table></div>';
            container.innerHTML = html;
        }

        // ============================================================
        // TRADEBOOK API CALLS
        // ============================================================

        async function fetchTradebook() {
            showLoading('tradebookLoading', true);
            
            try {
                const response = await fetch('/api/tradebook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                
                const data = await response.json();
                showLoading('tradebookLoading', false);
                
                if (data.success) {
                    displayTradebook(data.data);
                    document.getElementById('tradebookTimestamp').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
                } else {
                    document.getElementById('tradebookContent').innerHTML = `<div class="alert alert-error">Failed to load trades: ${data.error || 'Unknown error'}</div>`;
                }
            } catch (error) {
                console.error('Tradebook error:', error);
                showLoading('tradebookLoading', false);
                document.getElementById('tradebookContent').innerHTML = '<div class="alert alert-error">Error fetching tradebook</div>';
            }
        }

        function displayTradebook(trades) {
            const container = document.getElementById('tradebookContent');
            
            if (!trades || trades.length === 0) {
                container.innerHTML = '<p class="text-muted text-center">No trades found</p>';
                return;
            }

            let html = '<div class="table-wrap"><table class="results-table"><thead><tr>';
            html += '<th>#</th>';
            html += '<th>Order ID</th>';
            html += '<th>Exchange</th>';
            html += '<th>Symbol</th>';
            html += '<th>Side</th>';
            html += '<th>Qty</th>';
            html += '<th>Price</th>';
            html += '<th>Fill Qty</th>';
            html += '<th>Fill Price</th>';
            html += '<th>Fill ID</th>';
            html += '<th>Product</th>';
            html += '<th>Time</th>';
            html += '</tr></thead><tbody>';

            trades.forEach((trade, index) => {
                html += `<tr>
                    <td>${index + 1}</td>
                    <td><code>${trade.norenordno || '-'}</code></td>
                    <td><span class="badge badge-info">${trade.exch || '-'}</span></td>
                    <td><strong>${trade.tsym || '-'}</strong></td>
                    <td>${getSideBadge(trade.trantype)}</td>
                    <td>${trade.qty || '-'}</td>
                    <td>${trade.prc || '-'}</td>
                    <td>${trade.flqty || trade.fillshares || '-'}</td>
                    <td>${trade.flprc || '-'}</td>
                    <td><code>${trade.flid || '-'}</code></td>
                    <td>${trade.prd || '-'}</td>
                    <td>${trade.norentm || '-'}</td>
                </tr>`;
            });

            html += '</tbody></table></div>';
            container.innerHTML = html;
        }

        // ============================================================
        // POSITIONBOOK API CALLS
        // ============================================================

        async function fetchPositionbook() {
            showLoading('positionbookLoading', true);
            
            try {
                const response = await fetch('/api/positionbook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                
                const data = await response.json();
                showLoading('positionbookLoading', false);
                
                if (data.success) {
                    displayPositionbook(data.data);
                    document.getElementById('positionbookTimestamp').textContent = `Last updated: ${new Date().toLocaleTimeString()}`;
                } else {
                    document.getElementById('positionbookContent').innerHTML = `<div class="alert alert-error">Failed to load positions: ${data.error || 'Unknown error'}</div>`;
                }
            } catch (error) {
                console.error('Positionbook error:', error);
                showLoading('positionbookLoading', false);
                document.getElementById('positionbookContent').innerHTML = '<div class="alert alert-error">Error fetching positionbook</div>';
            }
        }

        function displayPositionbook(positions) {
            const container = document.getElementById('positionbookContent');
            
            if (!positions || positions.length === 0) {
                container.innerHTML = '<p class="text-muted text-center">No positions found</p>';
                return;
            }

            let html = '<div class="table-wrap"><table class="results-table"><thead><tr>';
            html += '<th>#</th>';
            html += '<th>Exchange</th>';
            html += '<th>Symbol</th>';
            html += '<th>Product</th>';
            html += '<th>Net Qty</th>';
            html += '<th>Net Avg Price</th>';
            html += '<th>Day Buy</th>';
            html += '<th>Day Sell</th>';
            html += '<th>LTP</th>';
            html += '<th>P&L</th>';
            html += '<th>Realized P&L</th>';
            html += '<th>Unrealized MTOM</th>';
            html += '</tr></thead><tbody>';

            positions.forEach((pos, index) => {
                const netQty = parseFloat(pos.netqty) || 0;
                const pnl = netQty * ((parseFloat(pos.lp) || 0) - (parseFloat(pos.netavgprc) || 0));
                
                html += `<tr>
                    <td>${index + 1}</td>
                    <td><span class="badge badge-info">${pos.exch || '-'}</span></td>
                    <td><strong>${pos.tsym || '-'}</strong></td>
                    <td>${pos.prd || '-'}</td>
                    <td><strong style="color: ${netQty > 0 ? '#48bb78' : netQty < 0 ? '#fc8181' : '#718096'}">${netQty}</strong></td>
                    <td>${pos.netavgprc || '-'}</td>
                    <td>${pos.daybuyqty || '0'}</td>
                    <td>${pos.daysellqty || '0'}</td>
                    <td>${pos.lp || '-'}</td>
                    <td style="color: ${pnl > 0 ? '#48bb78' : pnl < 0 ? '#fc8181' : '#718096'}">${pnl.toFixed(2)}</td>
                    <td>${pos.rpnl || '0.00'}</td>
                    <td>${pos.urmtom || '0.00'}</td>
                </tr>`;
            });

            html += '</tbody></table></div>';
            container.innerHTML = html;
        }

        // ============================================================
        // DISPLAY FUNCTIONS
        // ============================================================

        function displayResults(results, count) {
            currentResults = results || [];
            
            const container = document.getElementById('resultsContainer');
            const tableContainer = document.getElementById('resultsTableContainer');
            
            if (!currentResults.length) {
                container.classList.remove('hidden');
                document.getElementById('resultCount').textContent = '(No results found)';
                tableContainer.innerHTML = '<p class="text-muted text-center">No matching symbols found</p>';
                return;
            }
            
            document.getElementById('resultCount').textContent = `(${count} found)`;
            
            let html = '<div class="table-wrap"><table class="results-table"><thead><tr>';
            html += '<th>#</th>';
            html += '<th>Exchange</th>';
            html += '<th>Symbol</th>';
            html += '<th>Token</th>';
            html += '<th>Name</th>';
            html += '<th>Expiry</th>';
            html += '<th>Option Type</th>';
            html += '<th>Strike</th>';
            html += '<th>Actions</th>';
            html += '</tr></thead><tbody>';
            
            currentResults.forEach((item, index) => {
                const exch = item.exch || item.exchange || '-';
                const token = item.token || '-';
                const tsym = item.tsym || item.symbol || '-';
                const name = item.name || item.sname || '-';
                const expi = item.expi || item.expiry || '-';
                const optTyp = item.opt_typ || item.option_type || '-';
                const strkPrc = item.strk_prc || item.strike_price || '-';
                
                html += `<tr>
                    <td>${index + 1}</td>
                    <td><span class="badge badge-info">${exch}</span></td>
                    <td><strong>${tsym}</strong></td>
                    <td><code>${token}</code></td>
                    <td>${name}</td>
                    <td>${expi}</td>
                    <td>${optTyp}</td>
                    <td>${strkPrc}</td>
                    <td>
                        <button class="btn btn-success btn-sm" onclick="getQuotes('${exch}', '${token}', '${tsym}')">
                            Get Quotes
                        </button>
                        <button class="btn btn-primary btn-sm" onclick="getQuotesBroker('${exch}', '${token}', '${tsym}')">
                            Via Broker
                        </button>
                    </td>
                </tr>`;
            });
            
            html += '</tbody></table></div>';
            
            container.classList.remove('hidden');
            tableContainer.innerHTML = html;
        }

        function displayQuotesInModal(data) {
            const modalContent = document.getElementById('modalContent');
            
            let html = '<div class="quote-details">';
            
            const fields = [
                { label: 'Symbol', key: 'cname' },
                { label: 'Exchange', key: 'exch' },
                { label: 'Expiry Date', key: 'exd' },
                { label: 'Instrument', key: 'instname' },
                { label: 'Lot Size', key: 'ls' },
                { label: 'Option Type', key: 'optt' },
                { label: 'Tick Size', key: 'ti' },
                { label: 'Token', key: 'token' },
                { label: 'Trading Symbol', key: 'tsym' }
            ];
            
            fields.forEach(field => {
                const value = data[field.key] || 'N/A';
                let displayValue = value;
                
                if (field.key === 'token') {
                    displayValue = `<code>${value}</code>`;
                }
                if (field.key === 'exch') {
                    displayValue = `<span class="badge badge-info">${value}</span>`;
                }
                if (field.key === 'optt') {
                    displayValue = `<span class="badge badge-warning">${value}</span>`;
                }
                if (field.key === 'instname') {
                    displayValue = `<span class="badge badge-success">${value}</span>`;
                }
                
                html += `
                    <div class="quote-item">
                        <span class="label">${field.label}</span>
                        <span class="value">${displayValue}</span>
                    </div>
                `;
            });
            
            html += '</div>';
            
            html += `
                <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                    <h4 style="font-size: 14px; color: #4a5568; margin-bottom: 8px;">Full Response Data</h4>
                    <div style="background: #f7fafc; padding: 12px; border-radius: 8px; font-family: 'Courier New', monospace; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto;">
                        ${JSON.stringify(data, null, 2)}
                    </div>
                </div>
            `;
            
            modalContent.innerHTML = html;
        }

        function closeQuotesModal() {
            document.getElementById('quotesModal').style.display = 'none';
            document.getElementById('modalContent').innerHTML = '';
        }

        window.onclick = function(event) {
            const modal = document.getElementById('quotesModal');
            if (event.target === modal) {
                closeQuotesModal();
            }
        }

        // ============================================================
        // AUTO-REFRESH
        // ============================================================

        function toggleAutoRefresh(type) {
            const checkbox = document.getElementById(`${type}AutoRefresh`);
            if (checkbox.checked) {
                startAutoRefresh(type);
            } else {
                stopAutoRefresh(type);
            }
        }

        function startAutoRefresh(type) {
            stopAutoRefresh(type);
            autoRefreshIntervals[type] = setInterval(() => {
                if (type === 'orderbook') fetchOrderbook();
                else if (type === 'tradebook') fetchTradebook();
                else if (type === 'positionbook') fetchPositionbook();
            }, 30000);
        }

        function stopAutoRefresh(type) {
            if (autoRefreshIntervals[type]) {
                clearInterval(autoRefreshIntervals[type]);
                delete autoRefreshIntervals[type];
            }
        }

        function refreshAll() {
            fetchOrderbook();
            fetchTradebook();
            fetchPositionbook();
            showAlert('All dashboards refreshed', 'success');
        }

        // ============================================================
        // INIT
        // ============================================================

        // Enter key support for search
        document.getElementById('searchText').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchScrip();
            }
        });

        // Load initial data
        document.addEventListener('DOMContentLoaded', function() {
            fetchOrderbook();
            fetchTradebook();
            fetchPositionbook();
            
            // Start auto-refresh
            startAutoRefresh('orderbook');
            startAutoRefresh('tradebook');
            startAutoRefresh('positionbook');
        });
    </script>
</body>
</html>
''')

print("HTML template created successfully at:", template_path)

# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("Flattrade - Trading Dashboard")
    print("=" * 60)
    print(f"Server running at: http://localhost:5000")
    print("=" * 60)
    print("\nFeatures:")
    print("  - Symbol Search & Quotes")
    print("  - Orderbook Dashboard")
    print("  - Tradebook Dashboard")
    print("  - Positionbook Dashboard")
    print("  - Auto-refresh every 30 seconds")
    print("=" * 60)
    print("\nPress Ctrl+C to stop the server\n")
    
    # Set default encoding for console
    if sys.platform == 'win32':
        import codecs
        sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer)
    
    app.run(
        host='0.0.0.0',
        port=5000,
        debug=True,
        threaded=True
    )