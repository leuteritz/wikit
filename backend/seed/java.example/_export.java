// ═══════════════════════════════════════════════════════════════════
// Wikit code export · 17 classes · 6 packages
// 2026-08-14 13:08:54 UTC
//
// Paste this whole text back into "Add code" to restore every class.
// Everything above a package statement is a comment and is dropped on import.
// ═══════════════════════════════════════════════════════════════════
// ──── com.acme.shop.catalog ───────────────────────────────────────
package com.acme.shop.catalog;
/**
 * A discount that applies to a group of products. Kept separate from the product itself:
 * a price rule changes with the season, a product does not.
 */
public final class PriceRule {

    private final String productPrefix;
    private final int percentOff;

    public PriceRule(String productPrefix, int percentOff) {
        this.productPrefix = productPrefix;
        this.percentOff = percentOff;
    }

    public boolean appliesTo(Product product) {
        return product != null && product.id().startsWith(productPrefix);
    }

    public int discount() {
        return percentOff;
    }
}

package com.acme.shop.catalog;

import com.acme.shop.util.Money;
/** One sellable article: an id, a name, and what it costs before any rule applies. */
public final class Product {

    private final String id;
    private final String name;
    private final Money basePrice;

    public Product(String id, String name, Money basePrice) {
        this.id = id;
        this.name = name;
        this.basePrice = basePrice;
    }

    public String id() {
        return id;
    }

    public String name() {
        return name;
    }

    public Money basePrice() {
        return basePrice;
    }
}

package com.acme.shop.catalog;

import com.acme.shop.util.Money;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
/**
 * Everything that can be sold, and what it currently costs. The price rules live here
 * and not on the product, so a rule change touches one place instead of every article.
 */
public class ProductCatalog {

    private final Map<String, Product> products = new HashMap<>();
    private final List<PriceRule> rules = new ArrayList<>();

    public void register(Product product, PriceRule rule) {
        products.put(product.id(), product);
        if (rule != null) {
            rules.add(rule);
        }
    }

    public Product find(String productId) {
        return products.get(productId);
    }

    /** The price after every matching rule — this is what an order line is charged. */
    public Money effectivePrice(String productId) {
        Product product = find(productId);
        if (product == null) {
            throw new IllegalArgumentException("Unknown product: " + productId);
        }
        long cents = product.basePrice().amount();
        for (PriceRule rule : rules) {
            if (rule.appliesTo(product)) {
                cents = cents - (cents * rule.discount() / 100L);
            }
        }
        return Money.of(cents, "EUR");
    }

    public int size() {
        return products.size();
    }
}

// ──── com.acme.shop.customer ──────────────────────────────────────
package com.acme.shop.customer;
/** Who is ordering. Inactive customers stay in the system — orders of theirs do not. */
public final class Customer {

    private final String id;
    private final String name;
    private final boolean active;

    public Customer(String id, String name, boolean active) {
        this.id = id;
        this.name = name;
        this.active = active;
    }

    public String id() {
        return id;
    }

    public String name() {
        return name;
    }

    public boolean isActive() {
        return active;
    }
}

package com.acme.shop.customer;

import com.acme.shop.util.Ids;
import java.util.HashMap;
import java.util.Map;
/**
 * The customer records and the one question the rest of the shop asks about them:
 * "may this person order?" — answered by {@link #require(String)}, which throws if not.
 */
public class CustomerService {

    private final Map<String, Customer> customers = new HashMap<>();

    public Customer register(String name) {
        Customer customer = new Customer(Ids.newCustomerId(), name, true);
        customers.put(customer.id(), customer);
        return customer;
    }

    public Customer findById(String customerId) {
        return customers.get(customerId);
    }

    /**
     * Guard, not a getter: it either returns the customer or refuses. Callers that only
     * need the name use {@link #findById(String)} instead.
     */
    public Customer require(String customerId) {
        Customer customer = findById(customerId);
        if (customer == null) {
            throw new IllegalArgumentException("Unknown customer: " + customerId);
        }
        if (!customer.isActive()) {
            throw new IllegalStateException("Customer is not active: " + customerId);
        }
        return customer;
    }
}

// ──── com.acme.shop.order ─────────────────────────────────────────
package com.acme.shop.order;

import com.acme.shop.util.Money;
import java.util.ArrayList;
import java.util.List;
/**
 * A customer's order and the only place that knows how its status may change.
 * It starts as DRAFT and moves forward — never back.
 */
public class Order {

    private final String id;
    private final String customerId;
    private final List<OrderLine> lines = new ArrayList<>();
    private OrderStatus status = OrderStatus.DRAFT;

    public Order(String id, String customerId) {
        this.id = id;
        this.customerId = customerId;
    }

    public String id() {
        return id;
    }

    public String customerId() {
        return customerId;
    }

    public void addLine(OrderLine line) {
        if (status != OrderStatus.DRAFT) {
            throw new IllegalStateException("Only a draft can take new lines");
        }
        lines.add(line);
    }

    public List<OrderLine> lines() {
        return lines;
    }

    /** Sum of every line. An empty order is zero, not an error — it just cannot be placed. */
    public Money total() {
        Money sum = Money.of(0L, "EUR");
        for (OrderLine line : lines) {
            sum = sum.plus(line.total());
        }
        return sum;
    }

    public OrderStatus status() {
        return status;
    }

    public void markPaid() {
        if (status == OrderStatus.CANCELLED) {
            throw new IllegalStateException("A cancelled order cannot be paid");
        }
        status = OrderStatus.PAID;
    }

    public void cancel() {
        if (status == OrderStatus.PAID) {
            throw new IllegalStateException("A paid order needs a refund, not a cancellation");
        }
        status = OrderStatus.CANCELLED;
    }
}

package com.acme.shop.order;

import com.acme.shop.util.Money;
/** One product on an order: what it is, how many, and at which price it was added. */
public final class OrderLine {

    private final String productId;
    private final int quantity;
    private final Money unitPrice;

    public OrderLine(String productId, int quantity, Money unitPrice) {
        this.productId = productId;
        this.quantity = quantity;
        this.unitPrice = unitPrice;
    }

    /**
     * The price is stored per line and not looked up again: what the customer saw when
     * ordering is what the customer pays, even if the catalog changes tomorrow.
     */
    public Money total() {
        return unitPrice.times(quantity);
    }

    public int quantity() {
        return quantity;
    }
}

package com.acme.shop.order;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
/**
 * Where orders are kept. In-memory here — the point is that everything above it
 * only ever calls save/findById and never learns where the data actually lives.
 */
public class OrderRepository {

    private final Map<String, Order> byId = new HashMap<>();

    public void save(Order order) {
        byId.put(order.id(), order);
    }

    public Order findById(String orderId) {
        return byId.get(orderId);
    }

    public List<Order> all() {
        return new ArrayList<>(byId.values());
    }
}

package com.acme.shop.order;

import com.acme.shop.catalog.ProductCatalog;
import com.acme.shop.customer.CustomerService;
import com.acme.shop.payment.PaymentGateway;
import com.acme.shop.payment.PaymentResult;
import com.acme.shop.util.Ids;
import com.acme.shop.util.Money;
/**
 * The one place that knows how an order comes about. Everything it needs is handed in,
 * so the flow can be read here in full — catalog, customer, payment and validation each
 * stay behind their own door.
 */
public class OrderService {

    private final OrderRepository repository;
    private final ProductCatalog catalog;
    private final CustomerService customers;
    private final PaymentGateway gateway;
    private final OrderValidator validator;

    public OrderService(OrderRepository repository, ProductCatalog catalog, CustomerService customers,
                        PaymentGateway gateway, OrderValidator validator) {
        this.repository = repository;
        this.catalog = catalog;
        this.customers = customers;
        this.gateway = gateway;
        this.validator = validator;
    }

    public Order draftFor(String customerId) {
        customers.require(customerId);
        Order order = new Order(Ids.newOrderId(), customerId);
        repository.save(order);
        return order;
    }

    public Order addItem(String orderId, String productId, int quantity) {
        Order order = find(orderId);
        if (quantity < 1) {
            throw new IllegalArgumentException("Quantity must be positive");
        }
        Money price = catalog.effectivePrice(productId);
        order.addLine(new OrderLine(productId, quantity, price));
        repository.save(order);
        return order;
    }

    public PaymentResult place(String orderId) {
        Order order = find(orderId);
        validator.check(order);
        PaymentResult result = gateway.charge(order.customerId(), order.total());
        if (result.isAccepted()) {
            order.markPaid();
            repository.save(order);
        }
        return result;
    }

    public Order cancel(String orderId) {
        Order order = find(orderId);
        order.cancel();
        repository.save(order);
        return order;
    }

    private Order find(String orderId) {
        Order order = repository.findById(orderId);
        if (order == null) {
            throw new IllegalArgumentException("Unknown order: " + orderId);
        }
        return order;
    }
}

package com.acme.shop.order;
/**
 * Where an order stands. The order moves forward only: a cancelled order never becomes
 * paid again, and that is enforced in {@link Order}, not here.
 */
public enum OrderStatus {
    DRAFT,
    PLACED,
    PAID,
    CANCELLED
}

package com.acme.shop.order;
/**
 * The rules an order must satisfy before it may be placed. One method on purpose:
 * every caller asks the same question, and the answer is either "fine" or an exception.
 */
public class OrderValidator {

    private static final int MAX_LINES = 50;

    public void check(Order order) {
        if (order.status() != OrderStatus.DRAFT) {
            throw new IllegalStateException("Only a draft can be placed");
        }
        if (order.lines().isEmpty()) {
            throw new IllegalStateException("An order needs at least one line");
        }
        if (order.lines().size() > MAX_LINES) {
            throw new IllegalStateException("Too many lines: " + order.lines().size());
        }
        if (order.total().isZero()) {
            throw new IllegalStateException("An order cannot total zero");
        }
    }
}

// ──── com.acme.shop.payment ───────────────────────────────────────
package com.acme.shop.payment;

import com.acme.shop.util.Money;
/**
 * The edge towards the payment provider. Stubbed here — what matters for the graph is
 * that only this class talks outward, and everyone else talks to it.
 */
public class PaymentGateway {

    private static final long LIMIT_CENTS = 500_000L;

    public PaymentResult charge(String customerId, Money amount) {
        if (amount.amount() > LIMIT_CENTS) {
            return new PaymentResult(false, "limit-exceeded", amount);
        }
        return new PaymentResult(true, "PAY-" + customerId + "-" + amount.amount(), amount);
    }

    public PaymentResult refund(String reference, Money amount) {
        return new PaymentResult(true, "REF-" + reference, amount);
    }
}

package com.acme.shop.payment;

import com.acme.shop.util.Money;
/**
 * What the gateway answered. A declined payment is a normal outcome, not an error —
 * hence a result object and not an exception.
 */
public final class PaymentResult {

    private final boolean accepted;
    private final String reference;
    private final Money amount;

    public PaymentResult(boolean accepted, String reference, Money amount) {
        this.accepted = accepted;
        this.reference = reference;
        this.amount = amount;
    }

    public boolean isAccepted() {
        return accepted;
    }

    public String reference() {
        return reference;
    }

    public Money amount() {
        return amount;
    }
}

package com.acme.shop.payment;

import com.acme.shop.util.Money;
/**
 * Giving money back. Separate from {@link PaymentGateway} because a refund is a decision,
 * while the gateway only carries it out.
 *
 * It takes a reference and an amount, not an order: payment knows nothing about orders,
 * and keeping it that way is what stops the two packages from depending on each other.
 */
public class RefundService {

    private final PaymentGateway gateway;

    public RefundService(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public PaymentResult refund(String reference, Money amount) {
        if (amount.isZero()) {
            throw new IllegalStateException("Nothing to refund");
        }
        return gateway.refund(reference, amount);
    }
}

// ──── com.acme.shop.util ──────────────────────────────────────────
package com.acme.shop.util;

import java.util.concurrent.atomic.AtomicLong;
/**
 * Identifiers for new records. One counter per kind, so an order id never collides
 * with a customer id even though both are just numbers with a prefix.
 */
public final class Ids {

    private static final AtomicLong ORDERS = new AtomicLong(1000L);
    private static final AtomicLong CUSTOMERS = new AtomicLong(1L);

    private Ids() {
    }

    public static String newOrderId() {
        return "ORD-" + ORDERS.incrementAndGet();
    }

    public static String newCustomerId() {
        return "CUS-" + CUSTOMERS.incrementAndGet();
    }
}

package com.acme.shop.util;
/**
 * A minor-unit amount with a currency. Immutable: every operation returns a new value,
 * so an amount can be passed around without anyone changing it behind your back.
 */
public final class Money {

    private final long cents;
    private final String currency;

    private Money(long cents, String currency) {
        this.cents = cents;
        this.currency = currency;
    }

    /** The only way in — the constructor stays private so no half-built amount escapes. */
    public static Money of(long cents, String currency) {
        if (currency == null || currency.isEmpty()) {
            throw new IllegalArgumentException("A currency is required");
        }
        return new Money(cents, currency);
    }

    public Money plus(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("Cannot add " + other.currency + " to " + currency);
        }
        return new Money(cents + other.cents, currency);
    }

    public Money times(int factor) {
        return new Money(cents * factor, currency);
    }

    public long amount() {
        return cents;
    }

    public boolean isZero() {
        return cents == 0L;
    }

    @Override
    public String toString() {
        return (cents / 100) + "." + String.format("%02d", Math.abs(cents % 100)) + " " + currency;
    }
}

// ──── com.acme.shop.web ───────────────────────────────────────────
package com.acme.shop.web;

import com.acme.shop.order.Order;
import com.acme.shop.order.OrderService;
import com.acme.shop.payment.PaymentResult;
/**
 * HTTP edge. Holds no state and makes no decisions of its own — it turns a request into
 * one call on {@link OrderService} and hands the answer back.
 */
public class CheckoutController {

    private final OrderService orders;

    public CheckoutController(OrderService orders) {
        this.orders = orders;
    }

    public Order create(String customerId) {
        return orders.draftFor(customerId);
    }

    public Order addItem(String orderId, String productId, int quantity) {
        return orders.addItem(orderId, productId, quantity);
    }

    public PaymentResult checkout(String orderId) {
        return orders.place(orderId);
    }
}
