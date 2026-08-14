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
